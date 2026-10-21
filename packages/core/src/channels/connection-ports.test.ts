import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import type { TalkHistory } from "../connections/types.js";
import {
  historyQueryLimit,
  historyWindowHours,
} from "../connections/integrations/talk-features.js";
import {
  connectionPorts,
  LIVE_DEFAULT_WINDOW_MS,
  LIVE_READ_TTL_MS,
  recordedChannelOf,
  type ConnectionPortsDeps,
} from "./connection-ports.js";
import { testMessagesQueryContract } from "./messages-contract.js";
import { ChannelNotConnected } from "./channel.js";
import { ConnectionRegistry } from "../connections/registry.js";
import { DrizzleGrantLedger } from "../connections/ledger-db.js";
import { makePasteTalk } from "../connections/test-fixtures.js";
import { createTestDb, serviceChannelOf } from "../test/helpers.js";
import { systemClock } from "../lib/clock.js";
import { ConnectionPacing } from "./delivery/connection-pacing.js";
import { plainText } from "./delivery/types.js";

// A channel with no store answers `query` through its Connection's history.
// That history reads a window rounded out to whole hours, as the adapters do,
// so the contract's `since` case is what pins the port's own cut.

const HOUR = 3_600_000;

function said(id: string, chatId: string, hoursAgo: number): ChannelMessage {
  return {
    channel: "telegram_user",
    direction: "inbound",
    messageId: id,
    chatId: chatId as ChatId,
    senderId: "7",
    senderDisplayName: "Chat",
    text: id,
    attachments: [],
    timestamp: new Date(Date.now() - hoursAgo * HOUR),
    thread: { kind: chatId === "group-1" ? "group" : "dm" },
  };
}

/** A Connection's history over an adapter's read, as the integrations build it. */
function historyOver(
  fetchHistory: (chatId: string | null, windowHours: number) => Promise<ChannelMessage[]>,
): TalkHistory {
  return {
    async query(input) {
      const messages = await fetchHistory(input.chatId ?? null, historyWindowHours(input.since));
      return messages.slice(0, historyQueryLimit(input.limit));
    },
  };
}

testMessagesQueryContract("connection-backed messages", () => {
  const held = [
    // Inside the whole hour a `since` at g2 rounds out to, so a port that kept
    // the rounded window would answer g1 as well.
    said("g1", "group-1", 1.8),
    said("g2", "group-1", 1.5),
    said("g3", "group-1", 1.5),
    said("d1", "dm-1", 1),
  ];
  // An adapter's read: everything in the whole-hour window, oldest first.
  const history = historyOver(async (chatId, windowHours) => {
    const cutoff = Date.now() - windowHours * HOUR;
    return held.filter(
      (m) => (chatId === null || m.chatId === chatId) && m.timestamp.getTime() >= cutoff,
    );
  });
  const deps = {
    registry: {
      getDescriptor: () => ({ capabilities: { talker: { history: true } } }),
      find: () => [
        {
          id: "conn-1",
          withTalker: (call: (talker: object) => unknown) => call({ history }),
          hearTalker: () => () => {},
        },
      ],
      onUnlocked: () => {},
      registeredServices: () => ["telegram_user"],
    },
    channelOf: () => "telegram_user",
  } as unknown as ConnectionPortsDeps;
  const messages = connectionPorts(deps, "telegram_user")?.messages;
  if (!messages) throw new Error("a talker with history backs the channel's messages");
  return {
    messages,
    channel: "telegram_user",
    conversation: "group-1" as ChatId,
    silentConversation: "quiet-1" as ChatId,
  };
});

describe("connection-backed messages", () => {
  // A line older than the default window: reached by naming a `since`, and
  // left out of a query that names none.
  it("reaches back the default window unless a since is named", async () => {
    const old = said("old", "dm-1", 30);
    const recent = said("recent", "dm-1", 1);
    const history = historyOver(async (_chatId, windowHours) => {
      const cutoff = Date.now() - windowHours * HOUR;
      return [old, recent].filter((m) => m.timestamp.getTime() >= cutoff);
    });
    const deps = {
      registry: {
        getDescriptor: () => ({ capabilities: { talker: { history: true } } }),
        find: () => [
          {
            id: "conn-1",
            withTalker: (call: (talker: object) => unknown) => call({ history }),
            hearTalker: () => () => {},
          },
        ],
        onUnlocked: () => {},
        registeredServices: () => ["telegram_user"],
      },
      channelOf: () => "telegram_user",
    } as unknown as ConnectionPortsDeps;
    const messages = connectionPorts(deps, "telegram_user")?.messages;

    expect(LIVE_DEFAULT_WINDOW_MS).toBe(24 * HOUR);
    const ids = (page: Array<{ messageId: string }> | undefined) => page?.map((m) => m.messageId);
    expect(ids(await messages?.query({}))).toEqual(["recent"]);
    expect(ids(await messages?.query({ since: new Date(Date.now() - 48 * HOUR) }))).toEqual([
      "recent",
      "old",
    ]);
  });
});

// A read over every conversation that joins each conversation's lines one
// after another, as Discord's does, still answers the newest lines first.
describe("connection-backed messages, across conversations", () => {
  it("answers the newest lines first whatever order the history joins them in", async () => {
    const lines = [said("a-old", "dm-1", 3), said("a-new", "dm-1", 1), said("b-mid", "dm-2", 2)];
    const history = historyOver(async () => lines);
    const deps = {
      registry: {
        getDescriptor: () => ({ capabilities: { talker: { history: true } } }),
        find: () => [
          {
            id: "conn-1",
            withTalker: (call: (talker: object) => unknown) => call({ history }),
            hearTalker: () => () => {},
          },
        ],
        onUnlocked: () => {},
        registeredServices: () => ["telegram_user"],
      },
      channelOf: () => "telegram_user",
    } as unknown as ConnectionPortsDeps;
    const messages = connectionPorts(deps, "telegram_user")?.messages;

    const page = await messages?.query({ limit: 2 });

    expect(page?.map((m) => m.messageId)).toEqual(["a-new", "b-mid"]);
  });
});

describe("connection-backed messages, shared reads", () => {
  const NOW = Date.parse("2026-09-30T12:00:00.000Z");
  let clock = NOW;
  afterEach(() => {
    rs.restoreAllMocks();
    clock = NOW;
  });

  function line(id: string, minutesAgo: number): ChannelMessage {
    return {
      channel: "telegram_user",
      direction: "inbound",
      messageId: id,
      chatId: "dm-1" as ChatId,
      senderId: "7",
      text: id,
      attachments: [],
      timestamp: new Date(NOW - minutesAgo * 60_000),
    };
  }

  // A live read that counts itself, answering `lines(input)` oldest first.
  function port(lines: (input: { since?: Date }) => ChannelMessage[] | Promise<ChannelMessage[]>) {
    rs.spyOn(Date, "now").mockImplementation(() => clock);
    const query = rs.fn<TalkHistory["query"]>(async (input) => lines(input));
    const deps = {
      registry: {
        getDescriptor: () => ({ capabilities: { talker: { history: true } } }),
        find: () => [
          {
            id: "conn-1",
            withTalker: (call: (talker: object) => unknown) => call({ history: { query } }),
            hearTalker: () => () => {},
          },
        ],
        onUnlocked: () => {},
        registeredServices: () => ["telegram_user"],
      },
      channelOf: () => "telegram_user",
    } as unknown as ConnectionPortsDeps;
    const messages = connectionPorts(deps, "telegram_user")?.messages;
    if (!messages) throw new Error("a talker with history backs the channel's messages");
    return { messages, query };
  }

  const ids = (page: ChannelMessage[]) => page.map((m) => m.messageId);

  it("shares a read over the same whole-hour window", async () => {
    const { messages, query } = port(() => [line("older", 50), line("newer", 5)]);

    await messages.query({ since: new Date(NOW - 60 * 60_000) });
    clock += LIVE_READ_TTL_MS - 1;
    const narrower = await messages.query({ since: new Date(NOW - 10 * 60_000), limit: 5 });

    expect(query).toHaveBeenCalledTimes(1);
    expect(ids(narrower)).toEqual(["newer"]);
  });

  it("shares a read still under way", async () => {
    const { messages, query } = port(() => [line("only", 5)]);

    const [first, second] = await Promise.all([messages.query({}), messages.query({})]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(ids(first)).toEqual(["only"]);
    expect(ids(second)).toEqual(["only"]);
  });

  it("reads again once the read is stale, or reaches further back", async () => {
    const { messages, query } = port(() => [line("only", 5)]);

    await messages.query({ since: new Date(NOW - 60 * 60_000) });
    await messages.query({ since: new Date(NOW - 120 * 60_000) });
    clock += LIVE_READ_TTL_MS;
    await messages.query({ since: new Date(NOW - 60 * 60_000) });

    expect(query).toHaveBeenCalledTimes(3);
  });

  it("keeps a conversation's read apart from the whole account's", async () => {
    const { messages, query } = port(() => [line("only", 5)]);

    await messages.query({});
    await messages.query({ chatId: "dm-1" as ChatId });

    expect(query).toHaveBeenCalledTimes(2);
  });

  // Discord keeps the oldest lines of each channel after its cutoff, so a
  // day's read of a busy channel can hold none of the last hour's.
  it("does not answer a narrower window from a wider read", async () => {
    const said = [line("day-1", 20 * 60), line("day-2", 19 * 60), line("recent", 30)];
    const oldestTwo = ({ since }: { since?: Date }) =>
      said.filter((m) => m.timestamp.getTime() >= (since?.getTime() ?? 0)).slice(0, 2);
    const { messages, query } = port(oldestTwo);

    expect(ids(await messages.query({}))).toEqual(["day-2", "day-1"]);
    expect(ids(await messages.query({ since: new Date(NOW - 60 * 60_000) }))).toEqual(["recent"]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("answers each caller its own copy of a shared read", async () => {
    const said = {
      ...line("only", 5),
      attachments: [{ type: "image" as const, caption: "a photo" }],
      thread: { kind: "dm" as const, name: "Ada" },
      replyTo: { messageId: "m0", content: "earlier" },
    };
    const { messages, query } = port(() => [said]);
    const at = said.timestamp.getTime();

    const [first] = await messages.query({});
    first!.text = "edited";
    first!.attachments[0]!.caption = "edited";
    first!.attachments.push({ type: "document" });
    first!.thread!.name = "edited";
    first!.replyTo!.content = "edited";
    first!.timestamp.setTime(0);
    const [second] = await messages.query({});

    expect(query).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      text: "only",
      attachments: [{ caption: "a photo" }],
      thread: { name: "Ada" },
      replyTo: { content: "earlier" },
    });
    expect(second!.attachments).toHaveLength(1);
    expect(second!.timestamp.getTime()).toBe(at);
  });

  it("does not keep a failed read", async () => {
    let fail = true;
    const { messages, query } = port(() => {
      if (fail) throw new Error("platform down");
      return [line("only", 5)];
    });

    await expect(messages.query({})).rejects.toThrow("platform down");
    fail = false;
    expect(ids(await messages.query({}))).toEqual(["only"]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("connection-backed send, across epochs", () => {
  it("keeps a held direct port on whichever talker is live", async () => {
    const registry = new ConnectionRegistry({
      ledger: new DrizzleGrantLedger(createTestDb().db),
    });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    const connection = await registry.connect("fake-telegram");
    const offerDirect = (answer: string) => {
      const talker = fx.talkerFactory.instances.at(-1);
      if (!talker) throw new Error("talker not built");
      talker.directMessaging = { chatFor: async () => answer as ChatId };
    };
    await registry.importCredential(connection.id, "bot", fx.validCredential());
    offerDirect("first");
    const direct = connectionPorts({ registry, channelOf: serviceChannelOf }, "fake-telegram")?.send
      ?.direct;
    if (!direct) throw new Error("the talker offers direct messaging");
    await expect(direct.chatFor("7")).resolves.toBe("first");
    await expect(direct.conversationFor("7")).resolves.toBe("first");

    await connection.auth.revoke("bot");
    await expect(direct.chatFor("7")).rejects.toBeInstanceOf(ChannelNotConnected);

    await registry.importCredential(connection.id, "bot", fx.validCredential());
    offerDirect("second");
    await expect(direct.chatFor("7")).resolves.toBe("second");
  });
});

describe("connection ports for a service's later channels", () => {
  it("hears and sends on each channel through its own Connection", async () => {
    const { db } = createTestDb();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    const first = await registry.connect("fake-telegram");
    const second = await registry.connectAnother("fake-telegram");
    const names = new Map([
      [first.id, "fake-telegram"],
      [second.id, "fake-telegram-2"],
    ]);
    const deps: ConnectionPortsDeps = {
      registry,
      channelOf: (connection) => names.get(connection.id) ?? connection.service,
    };
    const ports = {
      first: connectionPorts(deps, "fake-telegram"),
      second: connectionPorts(deps, "fake-telegram", "fake-telegram-2"),
    };
    const heard: Array<{ channel: string; connectionId: string }> = [];
    for (const port of Object.values(ports)) {
      port?.inbound?.subscribe(async (event) => {
        heard.push({ channel: event.message.channel, connectionId: event.ref.connectionId });
      });
    }
    await registry.importCredential(first.id, "bot", fx.validCredential());
    const firstTalker = fx.talkerFactory.instances.at(-1)!;
    await registry.importCredential(second.id, "bot", fx.validCredential());
    const secondTalker = fx.talkerFactory.instances.at(-1)!;

    secondTalker.state.deliver?.({ ...said("m1", "dm-1", 0), channel: "fake-telegram" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual([{ channel: "fake-telegram-2", connectionId: second.id }]);

    await ports.second?.send?.send("dm-1" as ChatId, { text: "hi" });
    expect(secondTalker.state.sends).toHaveLength(1);
    expect(firstTalker.state.sends).toHaveLength(0);
  });
});

describe("a channel Rome does not listen to", () => {
  function setup(listenedAtFirst: boolean) {
    const { db } = createTestDb();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    let listened = listenedAtFirst;
    const listeners: Array<(channel: string) => void> = [];
    const admitted: string[] = [];
    const deps: ConnectionPortsDeps = {
      registry,
      channelOf: serviceChannelOf,
      admit: async (_connectionId, _service, message) => {
        admitted.push(message.messageId);
        return true;
      },
      listening: {
        listens: (channel) => channel === "fake-telegram" && listened,
        onChange: (listener) => listeners.push(listener),
      },
    };
    const ports = connectionPorts(deps, "fake-telegram")!;
    const heard: string[] = [];
    ports.inbound!.subscribe(async (event) => {
      heard.push(event.message.messageId);
    });
    const listen = (to: boolean, channel = "fake-telegram") => {
      listened = to;
      for (const listener of listeners) listener(channel);
    };
    const deliver = async (id: string) => {
      fx.talkerFactory.instances.at(-1)!.state.deliver!({
        ...said(id, "dm-1", 0),
        channel: "fake-telegram",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { registry, fx, ports, heard, admitted, listen, deliver };
  }

  it("hears nothing, not even admission, until it is listened to", async () => {
    const { registry, fx, heard, admitted, listen, deliver } = setup(false);
    const connection = await registry.connect("fake-telegram");
    await registry.importCredential(connection.id, "bot", fx.validCredential());

    await deliver("before");
    expect(heard).toEqual([]);
    expect(admitted).toEqual([]);

    listen(true);
    await deliver("after");
    expect(heard).toEqual(["after"]);
    expect(admitted).toEqual(["after"]);
  });

  it("stops hearing when it stops being listened to, and starts again", async () => {
    const { registry, fx, heard, listen, deliver } = setup(true);
    const connection = await registry.connect("fake-telegram");
    await registry.importCredential(connection.id, "bot", fx.validCredential());

    await deliver("m1");
    listen(false);
    await deliver("m2");
    listen(true);
    // A second change to the same answer adds no second subscription.
    listen(true);
    await deliver("m3");

    expect(heard).toEqual(["m1", "m3"]);
  });

  it("ignores a change to another channel", async () => {
    const { registry, fx, heard, listen, deliver } = setup(false);
    const connection = await registry.connect("fake-telegram");
    await registry.importCredential(connection.id, "bot", fx.validCredential());

    listen(true, "fake-telegram-2");
    await deliver("m1");

    expect(heard).toEqual([]);
  });

  it("sends whether or not it is listened to", async () => {
    const { registry, fx, ports } = setup(false);
    const connection = await registry.connect("fake-telegram");
    await registry.importCredential(connection.id, "bot", fx.validCredential());

    await ports.send!.send("dm-1" as ChatId, { text: "hi" });

    expect(fx.talkerFactory.instances.at(-1)!.state.sends).toHaveLength(1);
  });

  it("starts listening on a Connection that unlocks after it was listened to", async () => {
    const { registry, fx, heard, listen, deliver } = setup(false);
    const connection = await registry.connect("fake-telegram");
    listen(true);
    await registry.importCredential(connection.id, "bot", fx.validCredential());

    await deliver("m1");

    expect(heard).toEqual(["m1"]);
  });
});

describe("a Connection with no channel record", () => {
  it("backs no channel, not even its service's first", async () => {
    const { db } = createTestDb();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    // The service's only Connection, so nothing else could back the channel.
    const unrecorded = await registry.connect("fake-telegram");
    const deps: ConnectionPortsDeps = {
      registry,
      channelOf: recordedChannelOf({ idOf: () => null }, () => true),
    };
    const ports = connectionPorts(deps, "fake-telegram")!;
    const heard: string[] = [];
    ports.inbound!.subscribe(async (event) => {
      heard.push(event.ref.connectionId);
    });
    await registry.importCredential(unrecorded.id, "bot", fx.validCredential());
    const talker = fx.talkerFactory.instances.at(-1)!;

    talker.state.deliver!({ ...said("m1", "dm-1", 0), channel: "fake-telegram" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual([]);
    await expect(ports.send!.send("dm-1" as ChatId, { text: "hi" })).rejects.toBeInstanceOf(
      ChannelNotConnected,
    );
    expect(talker.state.sends).toHaveLength(0);
    for (const lookup of [ports.send!.direct!.chatFor, ports.send!.direct!.conversationFor]) {
      await expect(lookup("7")).rejects.toBeInstanceOf(ChannelNotConnected);
    }
  });
});

describe("reply streaming ports", () => {
  const budget = { burst: 100, refillMs: 1, conversationSpacingMs: 0 };

  /**
   * A Connection whose talker sends, and streams when `streams` is set. Its
   * first send waits to be released, so a test can see whether the second
   * send starts before the first ends.
   */
  function portsFor({ pacing, streams = true }: { pacing?: ConnectionPacing; streams?: boolean }) {
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const live = { talker: true };
    const talker = {
      async send(_conversation: string, message: { text?: string }) {
        sent.push(`start ${message.text}`);
        if (message.text === "first") await gate;
        sent.push(`end ${message.text}`);
        return { chatId: "chat-1" };
      },
      ...(streams
        ? {
            replyDelivery: {
              capabilities: { maxPartLength: 10, edit: false, budget },
              codec: plainText,
              create: async () => ({ messageId: "m1", chatId: "chat-1" }),
            },
          }
        : {}),
    };
    const connection = {
      id: "conn-1",
      service: "telegram",
      withTalker: (call: (talker: object) => unknown) => (live.talker ? call(talker) : undefined),
      hearTalker: () => () => {},
    };
    const deps = {
      registry: {
        getDescriptor: () => ({ capabilities: { talker: {} } }),
        find: () => [connection],
        onUnlocked: () => {},
        registeredServices: () => ["telegram"],
      },
      channelOf: (each: { service: string }) => each.service,
      ...(pacing ? { pacing } : {}),
    } as unknown as ConnectionPortsDeps;
    return { send: connectionPorts(deps, "telegram")!.send!, sent, release, live };
  }

  const pacingWith = (on: boolean) => new ConnectionPacing(systemClock, async () => on);
  const chat = "chat-1" as ChatId;
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("offers no replies port without pacing, or from a talker that cannot stream", () => {
    expect(portsFor({}).send.replies).toBeNull();
    expect(portsFor({ pacing: pacingWith(true), streams: false }).send.replies).toBeNull();
  });

  it("offers the replies port whether or not reply streaming is on, since the caller reads the setting", () => {
    expect(portsFor({ pacing: pacingWith(false) }).send.replies).not.toBeNull();
  });

  it("paces ordinary sends one at a time while reply streaming is on", async () => {
    const { send, sent, release } = portsFor({ pacing: pacingWith(true) });
    const first = send.send(chat, { text: "first" });
    const second = send.send(chat, { text: "second" });
    await tick();
    expect(sent).toEqual(["start first"]);
    release();
    await Promise.all([first, second]);
    expect(sent).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("sends at once while reply streaming is off", async () => {
    const { send, sent, release } = portsFor({ pacing: pacingWith(false) });
    const first = send.send(chat, { text: "first" });
    const second = send.send(chat, { text: "second" });
    await tick();
    expect(sent).toEqual(["start first", "start second", "end second"]);
    release();
    await Promise.all([first, second]);
  });

  it("writes a reply through the live talker, and refuses while talk is locked", async () => {
    const { send, live } = portsFor({ pacing: pacingWith(true) });
    const replies = send.replies!;
    await expect(replies.transport.create("chat-1", "hi")).resolves.toEqual({
      messageId: "m1",
      chatId: "chat-1",
    });
    live.talker = false;
    await expect(replies.transport.create("chat-1", "hi")).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });
});
