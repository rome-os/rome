import { describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import {
  SlackAdapter,
  SlackApiError,
  type SlackBotIdentity,
  SlackSocketMode,
  type SlackEventCallback,
  type SlackSocketLike,
  type SlackWebApi,
  decodeSlackText,
  parseSlackChatId,
  readSocketAppId,
  splitSlackText,
} from "./slack.js";

class FakeSocket implements SlackSocketLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: never) => void>>();

  pings = 0;
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pings++;
  }
  close(): void {
    this.closed = true;
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: "message" | "close" | "pong" | "error", data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (type === "error") {
        (listener as (event: unknown) => void)(data);
        continue;
      }
      (listener as (event: { data: unknown }) => void)({ data: JSON.stringify(data) });
    }
  }
}

function fakeApi(overrides: Partial<SlackWebApi> = {}): SlackWebApi {
  return {
    authTest: rs.fn(async () => ({
      teamId: "T1",
      botUserId: "UBOT",
      botUsername: "scout",
      appId: "A1",
    })),
    openConnection: rs.fn(async () => "wss://example.invalid/socket"),
    postMessage: rs.fn(async () => ({ ts: "100.1" })),
    openDirectMessage: rs.fn(async () => "D9"),
    userName: rs.fn(async () => ({ displayName: "Ada", username: "ada" })),
    ...overrides,
  };
}

function eventsApi(envelopeId: string, event: SlackEventCallback["event"], eventId = envelopeId) {
  return {
    type: "events_api",
    envelope_id: envelopeId,
    payload: { type: "event_callback", team_id: "T1", event_id: eventId, event },
  };
}

async function startedAdapter(api = fakeApi()) {
  const sockets: FakeSocket[] = [];
  const faults: Array<{ kind: string; cause: unknown }> = [];
  const adapter = new SlackAdapter({
    botToken: "xoxb-1",
    appToken: "xapp-1",
    channel: "slack_bot",
    api,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onFault: (fault) => faults.push(fault),
  });
  const received: ChannelMessage[] = [];
  adapter.onInbound(async (message) => {
    received.push(message);
  });
  await adapter.start();
  return { adapter, api, sockets, faults, received };
}

describe("SlackAdapter inbound", () => {
  it("acknowledges each envelope and delivers a direct message as a DM", async () => {
    const { sockets, received } = await startedAdapter();
    sockets[0].emit(
      "message",
      eventsApi("env-1", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "UADA",
        text: "hello <@UBOT>",
        ts: "1700000000.000100",
      }),
    );
    expect(sockets[0].sent).toEqual([JSON.stringify({ envelope_id: "env-1" })]);
    await rs.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      channel: "slack_bot",
      direction: "inbound",
      chatId: "D1",
      senderId: "T1/UADA",
      senderDisplayName: "Ada",
      senderUsername: "ada",
      text: "hello",
      thread: { kind: "dm" },
      addressing: "direct",
    });
  });

  it("keeps a mention in a thread inside its channel's chat", async () => {
    const { sockets, received } = await startedAdapter();
    sockets[0].emit(
      "message",
      eventsApi("env-2", {
        type: "app_mention",
        channel: "C1",
        user: "UADA",
        text: "<@UBOT> summarize this",
        ts: "200.2",
        thread_ts: "150.0",
      }),
    );
    await rs.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      chatId: "C1",
      thread: { kind: "group" },
      addressing: "mention",
      replyTo: { messageId: "150.0" },
      text: "summarize this",
    });
  });

  it("drops Slack's redelivery of an event it already handled", async () => {
    const { sockets, received } = await startedAdapter();
    const event = {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "UADA",
      text: "once",
      ts: "1.0",
    };
    sockets[0].emit("message", eventsApi("env-a", event, "Ev1"));
    sockets[0].emit("message", eventsApi("env-b", event, "Ev1"));
    await rs.waitFor(() => expect(received).toHaveLength(1));
    expect(sockets[0].sent).toHaveLength(2);
  });

  it("ignores the bot's own messages, other bots, edits, and authors from another workspace", async () => {
    const { sockets, received } = await startedAdapter();
    const base = { type: "message", channel_type: "im", channel: "D1", text: "x", ts: "1.0" };
    sockets[0].emit("message", eventsApi("e1", { ...base, user: "UBOT" }));
    sockets[0].emit("message", eventsApi("e2", { ...base, user: "UX", bot_id: "B1" }));
    sockets[0].emit(
      "message",
      eventsApi("e3", { ...base, user: "UX", subtype: "message_changed" }),
    );
    sockets[0].emit("message", eventsApi("e4", { ...base, user: "UX", user_team: "T2" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);
  });

  it("keeps a slow name lookup from reordering a conversation", async () => {
    let releaseFirst: () => void = () => {};
    const api = fakeApi({
      userName: rs.fn(async (_token: string, userId: string) => {
        if (userId === "USLOW") await new Promise<void>((resolve) => (releaseFirst = resolve));
        return {};
      }),
    });
    const { sockets, received } = await startedAdapter(api);
    const base = { type: "message", channel_type: "im", channel: "D1" };
    sockets[0].emit(
      "message",
      eventsApi("e1", { ...base, user: "USLOW", text: "first", ts: "1.0" }),
    );
    sockets[0].emit(
      "message",
      eventsApi("e2", { ...base, user: "UFAST", text: "second", ts: "2.0" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);
    releaseFirst();
    await rs.waitFor(() => expect(received).toHaveLength(2));
    expect(received.map((message) => message.text)).toEqual(["first", "second"]);
  });

  it("drops events for another workspace or another app", async () => {
    const { sockets, received } = await startedAdapter();
    const event = {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "UX",
      text: "x",
      ts: "1.0",
    };
    sockets[0].emit("message", {
      type: "events_api",
      envelope_id: "e1",
      payload: { type: "event_callback", team_id: "T2", event_id: "Ev1", event },
    });
    sockets[0].emit("message", {
      type: "events_api",
      envelope_id: "e2",
      payload: { type: "event_callback", team_id: "T1", api_app_id: "A2", event_id: "Ev2", event },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);
  });

  it("refuses a connection whose hello names another app", async () => {
    const { sockets, faults } = await startedAdapter();
    sockets[0].emit("message", { type: "hello", connection_info: { app_id: "A2" } });
    expect(sockets[0].closed).toBe(true);
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe("credential");
  });

  it("reports an uninstalled app as a refused credential", async () => {
    const { sockets, faults } = await startedAdapter();
    sockets[0].emit("message", eventsApi("e1", { type: "app_uninstalled" }));
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe("credential");
  });

  it("opens a fresh connection when Slack retires the current one", async () => {
    const { sockets, api } = await startedAdapter();
    sockets[0].emit("message", { type: "disconnect", reason: "refresh_requested" });
    expect(sockets[0].closed).toBe(true);
    await rs.waitFor(() => expect(sockets).toHaveLength(2));
    expect(api.openConnection).toHaveBeenCalledTimes(2);
  });

  it("rejects start when Slack refuses the app-level token", async () => {
    const api = fakeApi({
      openConnection: rs.fn(async () => {
        throw new SlackApiError("invalid_auth");
      }),
    });
    await expect(startedAdapter(api)).rejects.toThrow(SlackApiError);
  });

  it("stays down when stopped while auth.test is in flight", async () => {
    let answer!: () => void;
    const api = fakeApi({
      authTest: rs.fn(
        () =>
          new Promise<SlackBotIdentity>((resolve) => {
            answer = () => resolve({ teamId: "T1", botUserId: "UBOT", appId: "A1" });
          }),
      ),
    });
    const adapter = new SlackAdapter({
      botToken: "xoxb-1",
      appToken: "xapp-1",
      channel: "slack_bot",
      api,
      createSocket: () => new FakeSocket(),
    });
    const starting = adapter.start();
    adapter.stop();
    answer();
    await starting;
    expect(api.openConnection).not.toHaveBeenCalled();
    expect(await adapter.directConversationFor("T1/UADA")).toBeNull();
  });
});

describe("readSocketAppId", () => {
  it("rejects when the connection fails instead of leaving the error unhandled", async () => {
    const socket = new FakeSocket();
    const probe = readSocketAppId(fakeApi(), "xapp-1", { createSocket: () => socket });
    await rs.waitFor(() => expect(socket.listenerCount("error")).toBe(1));
    socket.emit("error", new Error("connect ECONNREFUSED"));
    await expect(probe).rejects.toThrow(/ECONNREFUSED/);
    expect(socket.closed).toBe(true);
  });
});

describe("SlackSocketMode liveness", () => {
  function socketMode() {
    const sockets: FakeSocket[] = [];
    const faults: unknown[] = [];
    const mode = new SlackSocketMode({
      appToken: "xapp-1",
      api: fakeApi(),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onEvent: () => {},
      onFault: (cause) => faults.push(cause),
      helloTimeoutMs: 1_000,
      pingIntervalMs: 1_000,
    });
    return { mode, sockets, faults };
  }

  it("drops a connection that never says hello and opens another", async () => {
    rs.useFakeTimers();
    try {
      const { mode, sockets } = socketMode();
      await mode.start();
      await rs.advanceTimersByTimeAsync(1_000);
      expect(sockets[0].closed).toBe(true);
      await rs.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
      mode.stop();
    } finally {
      rs.useRealTimers();
    }
  });

  it("reports a fault once connections keep ending before hello", async () => {
    rs.useFakeTimers();
    try {
      const { mode, sockets, faults } = socketMode();
      await mode.start();
      await rs.advanceTimersByTimeAsync(120_000);
      expect(sockets).toHaveLength(6);
      expect(faults).toHaveLength(1);
      expect(sockets.every((socket) => socket.closed)).toBe(true);
      mode.stop();
    } finally {
      rs.useRealTimers();
    }
  });

  it("drops a connection whose ping goes unanswered and opens another", async () => {
    rs.useFakeTimers();
    try {
      const { mode, sockets } = socketMode();
      await mode.start();
      sockets[0].emit("message", { type: "hello" });
      await rs.advanceTimersByTimeAsync(1_000);
      expect(sockets[0].pings).toBe(1);
      await rs.advanceTimersByTimeAsync(1_000);
      expect(sockets[0].closed).toBe(true);
      await rs.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
      mode.stop();
    } finally {
      rs.useRealTimers();
    }
  });

  it("keeps a connection that answers its pings", async () => {
    rs.useFakeTimers();
    try {
      const { mode, sockets } = socketMode();
      await mode.start();
      sockets[0].emit("message", { type: "hello" });
      for (let round = 1; round <= 3; round++) {
        await rs.advanceTimersByTimeAsync(1_000);
        expect(sockets[0].pings).toBe(round);
        sockets[0].emit("pong");
      }
      expect(sockets).toHaveLength(1);
      expect(sockets[0].closed).toBe(false);
      mode.stop();
    } finally {
      rs.useRealTimers();
    }
  });
});

describe("SlackAdapter send", () => {
  function mention(ts: string, threadTs?: string) {
    return eventsApi(`env-${ts}`, {
      type: "app_mention",
      channel: "C1",
      user: "UADA",
      text: "<@UBOT> hi",
      ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  it("answers a mention inside a thread in that thread", async () => {
    const { adapter, api, sockets, received } = await startedAdapter();
    sockets[0].emit("message", mention("200.2", "150.0"));
    await rs.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].messageId).toBe("150.0:200.2");
    const receipt = await adapter.send("C1" as ChatId, {
      text: "**done**",
      replyToMessageId: received[0].messageId,
    });
    expect(api.postMessage).toHaveBeenCalledWith(
      "xoxb-1",
      { channel: "C1", markdown: "**done**", threadTs: "150.0" },
      expect.anything(),
    );
    expect(receipt).toEqual({ chatId: "C1", messageId: "150.0:100.1" });
  });

  it("answers a reply to its own message in the same thread", async () => {
    const { adapter, api } = await startedAdapter();
    const first = await adapter.send("C1" as ChatId, {
      text: "one",
      replyToMessageId: "150.0:200.2",
    });
    await adapter.send("C1" as ChatId, { text: "two", replyToMessageId: first.messageId });
    expect(api.postMessage).toHaveBeenLastCalledWith(
      "xoxb-1",
      { channel: "C1", markdown: "two", threadTs: "150.0" },
      expect.anything(),
    );
  });

  it("finds a mention's thread after a restart, with nothing remembered", async () => {
    const { adapter, api } = await startedAdapter();
    await adapter.send("C1" as ChatId, { text: "late", replyToMessageId: "150.0:200.2" });
    expect(api.postMessage).toHaveBeenCalledWith(
      "xoxb-1",
      { channel: "C1", markdown: "late", threadTs: "150.0" },
      expect.anything(),
    );
  });

  it("starts a thread under a mention in the channel itself", async () => {
    const { adapter, api, sockets, received } = await startedAdapter();
    sockets[0].emit("message", mention("300.3"));
    await rs.waitFor(() => expect(received).toHaveLength(1));
    await adapter.send("C1" as ChatId, { text: "ok", replyToMessageId: "300.3" });
    expect(api.postMessage).toHaveBeenCalledWith(
      "xoxb-1",
      { channel: "C1", markdown: "ok", threadTs: "300.3" },
      expect.anything(),
    );
  });

  it("answers a direct message in place", async () => {
    const { adapter, api } = await startedAdapter();
    await adapter.send("D1" as ChatId, { text: "ok", replyToMessageId: "400.4" });
    expect(api.postMessage).toHaveBeenCalledWith(
      "xoxb-1",
      { channel: "D1", markdown: "ok", threadTs: undefined },
      expect.anything(),
    );
  });

  it("still replies in the thread an older thread-keyed chat names", async () => {
    const { adapter, api } = await startedAdapter();
    const receipt = await adapter.send("C1:150.0" as ChatId, { text: "**done**" });
    expect(api.postMessage).toHaveBeenCalledWith(
      "xoxb-1",
      { channel: "C1", markdown: "**done**", threadTs: "150.0" },
      expect.anything(),
    );
    expect(receipt).toEqual({ chatId: "C1:150.0", messageId: "150.0:100.1" });
  });

  it("opens the direct message for a member's address", async () => {
    const { adapter, api } = await startedAdapter();
    await expect(adapter.directConversationFor("T1/UADA")).resolves.toBe("D9");
    expect(api.openDirectMessage).toHaveBeenCalledWith("xoxb-1", "UADA", expect.anything());
  });

  it("never opens a direct message for a member of another workspace", async () => {
    const { adapter, api } = await startedAdapter();
    await expect(adapter.directConversationFor("T2/UADA")).resolves.toBeNull();
    await expect(adapter.directConversationFor("UADA")).resolves.toBeNull();
    expect(api.openDirectMessage).not.toHaveBeenCalled();
  });
});

describe("slack text", () => {
  it("unwraps mentions, channels, links and entities", () => {
    expect(
      decodeSlackText(
        "<@UBOT> ask <@U2|bob> in <#C1|general> about <https://x.dev|docs> &amp; more",
        "UBOT",
      ),
    ).toBe("ask @bob in #general about docs (https://x.dev) & more");
  });

  it("splits long text without breaking a code point", () => {
    const chunks = splitSlackText("ab😀cd", 3);
    expect(chunks.join("")).toBe("ab😀cd");
    expect(chunks.every((chunk) => chunk.length <= 3)).toBe(true);
  });

  it("reads a thread address back into channel and thread", () => {
    expect(parseSlackChatId("C1:150.0")).toEqual({ channelId: "C1", threadTs: "150.0" });
    expect(parseSlackChatId("D1")).toEqual({ channelId: "D1" });
  });
});
