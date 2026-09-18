import { createHmac } from "node:crypto";
import type { InboundMessage } from "@rome-os/app-runtime";
import { describe, expect, it, rs } from "@rstest/core";
import {
  SlackAdapter,
  SlackIngress,
  generateSlackGuardianLinkCode,
  parseSlackConversationId,
  slackWebApi,
  slackThreadConversationId,
  waitForSlackGuardianLink,
  type SlackEventEnvelope,
  type SlackWebApi,
} from "./slack.js";

const identity = {
  teamId: "T123",
  workspaceName: "Acme",
  botUserId: "UBOT",
  botUsername: "Rome",
};

function envelope(
  eventId: string,
  event: SlackEventEnvelope["event"],
  teamId = identity.teamId,
): SlackEventEnvelope {
  return { type: "event_callback", event_id: eventId, team_id: teamId, event };
}

function fakeApi() {
  const postMessage = rs.fn<SlackWebApi["postMessage"]>(async () => ({ ts: "reply.1" }));
  const api: SlackWebApi = {
    authTest: async () => identity,
    postMessage,
  };
  return { api, postMessage };
}

describe("SlackIngress", () => {
  it("verifies the untouched body and rejects stale or forged signatures", () => {
    const secret = "signing-secret";
    const ingress = new SlackIngress(secret);
    const body = '{"type":"event_callback"}';
    const timestamp = "1700000000";
    const signature = `v0=${createHmac("sha256", secret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;

    expect(
      ingress.verifyRequest(body, { timestamp, signature }, Number(timestamp) * 1_000),
    ).toEqual({ ok: true });
    expect(
      ingress.verifyRequest(`${body} `, { timestamp, signature }, Number(timestamp) * 1_000),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(
      ingress.verifyRequest(body, { timestamp, signature }, (Number(timestamp) + 301) * 1_000),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("authorizes by workspace and deduplicates Slack retries", async () => {
    const ingress = new SlackIngress("secret", { startupGraceMs: 0 });
    const handler = rs.fn(async () => {});
    ingress.subscribe(identity.teamId, handler);
    ingress.completeInitialRegistration();
    const event = envelope("Ev1", { type: "message", channel_type: "im" });

    await expect(ingress.dispatch(event)).resolves.toBe("delivered");
    await expect(ingress.dispatch(event)).resolves.toBe("duplicate");
    await expect(ingress.dispatch(envelope("Ev2", { type: "message" }, "T-OTHER"))).resolves.toBe(
      "unhandled",
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("records an event only after every handler succeeds", async () => {
    const ingress = new SlackIngress("secret");
    const first = rs.fn(async () => false);
    const second = rs.fn(async () => {
      if (second.mock.calls.length === 1) throw new Error("temporary failure");
      return true;
    });
    ingress.subscribe(identity.teamId, first);
    ingress.subscribe(identity.teamId, second);
    const event = envelope("Ev-retry", { type: "message", channel_type: "im" });

    await expect(ingress.dispatch(event)).rejects.toThrow("temporary failure");
    await expect(ingress.dispatch(event)).resolves.toBe("delivered");
    await expect(ingress.dispatch(event)).resolves.toBe("duplicate");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("does not run later handlers after one consumes the event", async () => {
    const ingress = new SlackIngress("secret");
    const consumer = rs.fn(async () => true);
    const later = rs.fn(async () => false);
    ingress.subscribe(identity.teamId, consumer);
    ingress.subscribe(identity.teamId, later);

    await expect(
      ingress.dispatch(envelope("Ev-consumed", { type: "message", channel_type: "im" })),
    ).resolves.toBe("delivered");
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
  });

  it("asks Slack to retry a delivery reserved by another process", async () => {
    const ingress = new SlackIngress("secret", {
      dedup: { reserve: async () => ({ state: "busy" }) },
    });
    const handler = rs.fn();
    ingress.subscribe(identity.teamId, handler);

    const event = envelope("Ev-busy", { type: "message", channel_type: "im" });
    await expect(Promise.all([ingress.dispatch(event), ingress.dispatch(event)])).resolves.toEqual([
      "retry",
      "retry",
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps a known workspace retryable while its handler is rebuilding", async () => {
    const ingress = new SlackIngress("secret", { startupGraceMs: 0 });
    ingress.completeInitialRegistration();
    const release = ingress.expectWorkspace(identity.teamId);

    await expect(
      ingress.dispatch(envelope("Ev-rebuild", { type: "message", channel_type: "im" })),
    ).resolves.toBe("starting");
    release();
    await expect(
      ingress.dispatch(envelope("Ev-disconnected", { type: "message", channel_type: "im" })),
    ).resolves.toBe("unhandled");
  });

  it("stops retrying a workspace whose handler remains unavailable across rebuilds", async () => {
    let now = 0;
    const ingress = new SlackIngress("secret", { now: () => now, startupGraceMs: 0 });
    ingress.completeInitialRegistration();
    const releaseFirst = ingress.expectWorkspace(identity.teamId);

    await expect(ingress.dispatch(envelope("Ev-first-backoff", { type: "message" }))).resolves.toBe(
      "starting",
    );
    now = 60_000;
    const releaseSecond = ingress.expectWorkspace(identity.teamId);
    now = 120_001;
    await expect(
      ingress.dispatch(envelope("Ev-bounded-backoff", { type: "message" })),
    ).resolves.toBe("unhandled");

    releaseFirst();
    releaseSecond();
  });

  it("releases a reservation if its snapshotted handler was removed", async () => {
    let resolveReservation!: (reservation: {
      state: "acquired";
      commit(): Promise<void>;
      release(): Promise<void>;
    }) => void;
    const commit = rs.fn(async () => {});
    const release = rs.fn(async () => {});
    const ingress = new SlackIngress("secret", {
      dedup: {
        reserve: () =>
          new Promise((resolve) => {
            resolveReservation = resolve;
          }),
      },
    });
    const handler = rs.fn();
    const unsubscribe = ingress.subscribe(identity.teamId, handler);
    const dispatch = ingress.dispatch(envelope("Ev-teardown", { type: "message" }));
    await Promise.resolve();
    unsubscribe();
    resolveReservation({ state: "acquired", commit, release });

    await expect(dispatch).resolves.toBe("retry");
    expect(handler).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds the process-wide unknown-workspace registration grace", async () => {
    let now = 0;
    const ingress = new SlackIngress("secret", { now: () => now, startupGraceMs: 0 });
    ingress.completeInitialRegistration();
    const finishRegistration = ingress.beginHandlerRegistration();

    await expect(
      ingress.dispatch(envelope("Ev-pending", { type: "message" }, "T-UNKNOWN")),
    ).resolves.toBe("starting");
    now = 30_001;
    await expect(
      ingress.dispatch(envelope("Ev-pending-expired", { type: "message" }, "T-UNKNOWN")),
    ).resolves.toBe("unhandled");
    finishRegistration();
  });
});

describe("SlackAdapter", () => {
  it("delivers DMs and channel mentions but not ordinary channel traffic", async () => {
    const ingress = new SlackIngress("secret");
    const { api } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });
    const messages: Parameters<Parameters<SlackAdapter["onMessage"]>[0]>[0][] = [];
    adapter.onMessage((message) => messages.push(message));
    await adapter.start();

    await ingress.dispatch(
      envelope("dm", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "<@UBOT> hello &amp; <@U9|Ada> in <#C9|general> read <https://example.com|docs> not &lt;@U8&gt;",
        ts: "1700000000.100",
      }),
    );
    await ingress.dispatch(
      envelope("ambient", {
        type: "message",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        text: "do not send this",
        ts: "1700000000.200",
      }),
    );
    await ingress.dispatch(
      envelope("mention", {
        type: "app_mention",
        channel: "C1",
        user: "U2",
        text: "<@UBOT|rome> help &lt;me&gt;",
        ts: "1700000000.300",
      }),
    );
    await ingress.dispatch(
      envelope("single-decode", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "literal &amp;lt; stays encoded once",
        ts: "1700000000.400",
      }),
    );
    await ingress.dispatch(
      envelope("dm-app-mention", {
        type: "app_mention",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "<@UBOT> only once",
        ts: "1700000000.500",
      }),
    );

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      conversationId: "D1",
      senderId: "T123/U1",
      text: "hello & @Ada in #general read docs (https://example.com) not <@U8>",
      addressing: "direct",
      thread: { kind: "dm" },
    });
    expect(messages[0]?.senderDisplayName).toBeUndefined();
    expect(messages[1]).toMatchObject({
      conversationId: "C1:1700000000.300",
      parentConversationId: "C1",
      senderId: "T123/U2",
      text: "help <me>",
      addressing: "mention",
      thread: { kind: "topic" },
    });
    expect(messages[1]?.senderDisplayName).toBeUndefined();
    expect(messages[1]?.thread).toEqual({ kind: "topic" });
    expect(messages[2]?.text).toBe("literal &lt; stays encoded once");
  });

  it("keeps later mentions in one Slack thread conversation", async () => {
    const ingress = new SlackIngress("secret");
    const { api } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });
    const messages: Array<{ conversationId: string; text: string }> = [];
    adapter.onMessage((message) => messages.push(message));
    await adapter.start();

    await ingress.dispatch(
      envelope("thread-mention", {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        text: "<@UBOT> /stop",
        ts: "1700000001.200",
        thread_ts: "1700000000.300",
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      conversationId: "C1:1700000000.300",
      text: "/stop",
    });
  });

  it("keeps a Slack DM thread separate and replies inside it", async () => {
    const ingress = new SlackIngress("secret");
    const { api, postMessage } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });
    const messages: InboundMessage[] = [];
    adapter.onMessage((message) => messages.push(message));
    await adapter.start();

    await ingress.dispatch(
      envelope("dm-thread", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "inside a thread",
        ts: "1700000002.200",
        thread_ts: "1700000001.100",
      }),
    );
    expect(messages[0]).toMatchObject({
      conversationId: "D1:1700000001.100",
      parentConversationId: "D1",
      thread: { kind: "dm" },
    });

    await adapter.send(messages[0]!.conversationId, { text: "thread answer" });
    expect(postMessage).toHaveBeenCalledWith(
      "xoxb-test",
      {
        channel: "D1",
        text: "thread answer",
        threadTs: "1700000001.100",
      },
      expect.any(AbortSignal),
    );
  });

  it("drops self-authored, bot-authored, and textless events", async () => {
    const ingress = new SlackIngress("secret");
    const { api } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });
    const handler = rs.fn(() => {});
    adapter.onMessage(handler);
    await adapter.start();

    for (const [eventId, event] of [
      [
        "self",
        { type: "message", channel_type: "im", channel: "D1", user: "UBOT", text: "x", ts: "1" },
      ],
      [
        "bot",
        {
          type: "message",
          channel_type: "im",
          channel: "D1",
          user: "U1",
          bot_id: "B1",
          text: "x",
          ts: "2",
        },
      ],
      [
        "empty",
        { type: "message", channel_type: "im", channel: "D1", user: "U1", text: "  ", ts: "3" },
      ],
    ] as const) {
      await ingress.dispatch(envelope(eventId, event));
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts text from a file-share DM while ignoring the file", async () => {
    const ingress = new SlackIngress("secret");
    const { api } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });
    const handler = rs.fn();
    adapter.onMessage(handler);
    await adapter.start();

    await ingress.dispatch(
      envelope("file-share", {
        type: "message",
        subtype: "file_share",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "please summarize this",
        ts: "1700000000.400",
      }),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ text: "please summarize this", attachments: [] }),
    );
  });

  it("drops a Slack Connect author instead of mapping them under the host workspace", async () => {
    const ingress = new SlackIngress("secret");
    const { api } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });
    const handler = rs.fn();
    adapter.onMessage(handler);
    await adapter.start();

    await ingress.dispatch(
      envelope("external", {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        team: "T-EXTERNAL",
        text: "<@UBOT> hello",
        ts: "1700000000.500",
      }),
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("posts channel answers in the addressed thread and DMs inline", async () => {
    const ingress = new SlackIngress("secret");
    const { api, postMessage } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });
    await adapter.start();

    await adapter.send(slackThreadConversationId("C1", "1700000000.300"), { text: "answer" });
    await adapter.send("D1" as never, { text: "private answer" });

    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      "xoxb-test",
      {
        channel: "C1",
        text: "answer",
        threadTs: "1700000000.300",
      },
      expect.any(AbortSignal),
    );
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      "xoxb-test",
      {
        channel: "D1",
        text: "private answer",
        threadTs: undefined,
      },
      expect.any(AbortSignal),
    );
    expect(parseSlackConversationId("D1")).toEqual({ channelId: "D1" });
  });

  it("escapes Slack control syntax and chunks without splitting a surrogate pair", async () => {
    const ingress = new SlackIngress("secret");
    const { api, postMessage } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });

    await adapter.send("D1" as never, { text: "hello <!channel> & <@U1>" });
    await adapter.send("D1" as never, { text: `${"a".repeat(3_999)}😀b` });

    expect(postMessage.mock.calls[0][1].text).toBe("hello &lt;!channel&gt; &amp; &lt;@U1&gt;");
    expect(postMessage.mock.calls[1][1].text).toBe("a".repeat(3_999));
    expect(postMessage.mock.calls[2][1].text).toBe("😀b");
  });

  it("aborts in-flight outbound sends when the adapter stops", async () => {
    const ingress = new SlackIngress("secret");
    const postMessage = rs.fn<SlackWebApi["postMessage"]>(
      async (_token, _input, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
            { once: true },
          );
        }),
    );
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      ingress,
      api: { authTest: async () => identity, postMessage },
    });

    const sending = adapter.send("D1" as never, { text: "hello" });
    adapter.stop();

    await expect(sending).rejects.toThrow("Slack adapter stopped");
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("retries one Slack HTTP rate limit using Retry-After", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = rs
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, ts: "reply.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    globalThis.fetch = fetchMock;
    try {
      rs.useFakeTimers();
      const request = slackWebApi.postMessage("xoxb-test", { channel: "D1", text: "hello" });
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await rs.advanceTimersByTimeAsync(1);
      await expect(request).resolves.toEqual({ ts: "reply.1" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
        text: "hello",
        mrkdwn: false,
      });
    } finally {
      rs.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });

  it("fails fast when Slack's requested rate-limit wait exceeds the retry bound", async () => {
    const originalFetch = globalThis.fetch;
    const cancel = rs.fn();
    const fetchMock = rs.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        status: 429,
        headers: { "retry-after": "31" },
      }),
    );
    globalThis.fetch = fetchMock;
    try {
      await expect(
        slackWebApi.postMessage("xoxb-test", { channel: "D1", text: "hello" }),
      ).rejects.toThrow("31000ms rate-limit wait");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cancels a failed Slack response body before throwing", async () => {
    const originalFetch = globalThis.fetch;
    const cancel = rs.fn();
    globalThis.fetch = rs
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 500 }));
    try {
      await expect(slackWebApi.authTest("xoxb-test")).rejects.toThrow("HTTP 500");
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes a non-Error abort reason while waiting to retry", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = rs
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "30" } }));
    globalThis.fetch = fetchMock;
    const controller = new AbortController();
    try {
      const request = slackWebApi.authTest("xoxb-test", controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort("cancelled");
      await expect(request).rejects.toThrow("Slack API wait aborted.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("posts valid JSON for auth.test and captures the application id", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = rs.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          team_id: "T1",
          user_id: "UBOT",
          app_id: "A1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;
    try {
      await expect(slackWebApi.authTest("xoxb-test")).resolves.toMatchObject({
        teamId: "T1",
        botUserId: "UBOT",
        appId: "A1",
      });
      expect(fetchMock.mock.calls[0]?.[1]?.body).toBe("{}");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ignores attachment-only output without claiming a message was sent", async () => {
    const ingress = new SlackIngress("secret");
    const { api, postMessage } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });

    await expect(
      adapter.send("D1" as never, {
        attachments: [{ type: "image", source: "file:///tmp/image.png" }],
      }),
    ).resolves.toEqual({});
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("renders a text-only fallback for an approval card", async () => {
    const ingress = new SlackIngress("secret");
    const { api, postMessage } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });

    await adapter.send("D1" as never, {
      parts: [
        {
          type: "approval_card",
          approvalId: "approval-1",
          actionName: "send_email",
          preview: { kind: "generic", title: "Send email", summary: "Send it" },
          status: "pending",
        },
      ],
    });

    expect(postMessage.mock.calls[0]?.[1].text).toContain(
      "Rome needs your approval to run send_email.",
    );
  });

  it("logs an approval card omitted in favor of canonical text", async () => {
    const ingress = new SlackIngress("secret");
    const { api, postMessage } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });
    const warn = rs.spyOn(console, "warn").mockImplementation(() => {});

    await adapter.send("D1" as never, {
      text: "Already rendered approval guidance",
      parts: [
        {
          type: "approval_card",
          approvalId: "approval-1",
          actionName: "send_email",
          preview: { kind: "generic", title: "Send email", summary: "Send it" },
          status: "pending",
        },
      ],
    });

    expect(postMessage.mock.calls[0]?.[1].text).toBe("Already rendered approval guidance");
    expect(warn.mock.calls.some(([line]) => String(line).includes('"parts":1'))).toBe(true);
    warn.mockRestore();
  });

  it("drops an inbound event from a different Slack application without degrading", async () => {
    const ingress = new SlackIngress("secret");
    const { api } = fakeApi();
    const onCredentialFault = rs.fn();
    const handler = rs.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      ingress,
      api,
      expectedAppId: "A-CONNECTED",
      onCredentialFault,
    });
    adapter.onMessage(handler);
    await adapter.start();

    await ingress.dispatch({
      ...envelope("wrong-app", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "hello",
        ts: "1700000000.900",
      }),
      api_app_id: "A-EVENT",
    });

    expect(handler).not.toHaveBeenCalled();
    expect(onCredentialFault).not.toHaveBeenCalled();
  });

  it("does not subscribe when stopped during the identity probe", async () => {
    const ingress = new SlackIngress("secret");
    let finishProbe: ((value: typeof identity) => void) | undefined;
    const api: SlackWebApi = {
      authTest: () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
      postMessage: async () => ({ ts: "unused" }),
    };
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });
    const handler = rs.fn(() => {});
    adapter.onMessage(handler);

    const starting = adapter.start();
    adapter.stop();
    finishProbe?.(identity);
    await starting;
    await ingress.dispatch(
      envelope("after-stop", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "hello",
        ts: "1700000002.100",
      }),
    );

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("Slack guardian linking", () => {
  it("generates an uppercase code with 48 bits of entropy", () => {
    expect(generateSlackGuardianLinkCode()).toMatch(/^ROME-LINK-[0-9A-F]{12}$/);
  });

  it("locks one sender after five incorrect attempts without aborting another sender", async () => {
    const ingress = new SlackIngress("secret");
    const controller = new AbortController();
    const fallback = rs.fn(() => true);
    ingress.subscribe(identity.teamId, fallback);
    const linking = waitForSlackGuardianLink(
      ingress,
      identity,
      "ROME-LINK-ABCDEFGH",
      controller.signal,
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await ingress.dispatch(
        envelope(`wrong-${attempt}`, {
          type: "message",
          channel_type: "im",
          channel: "D1",
          user: "U1",
          text: `ROME-LINK-WRONG00${attempt}`,
          ts: `1700000010.${attempt}`,
        }),
      );
    }
    expect(fallback).not.toHaveBeenCalled();

    await ingress.dispatch(
      envelope("locked-sender-correct", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "ROME-LINK-ABCDEFGH",
        ts: "1700000011.0",
      }),
    );
    let settled = false;
    void linking.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await ingress.dispatch(
      envelope("other-sender-correct", {
        type: "message",
        channel_type: "im",
        channel: "D2",
        user: "U2",
        text: "rome-link-abcdefgh",
        ts: "1700000011.1",
      }),
    );
    await expect(linking).resolves.toEqual({ channelUserId: "T123/U2" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("bounds attacker bookkeeping without blocking the correct guardian code", async () => {
    const ingress = new SlackIngress("secret");
    const controller = new AbortController();
    const rejected = rs.fn(async () => {});
    const linking = waitForSlackGuardianLink(
      ingress,
      identity,
      "ROME-LINK-ABCDEFGH",
      controller.signal,
      { onRejectedAttempt: rejected },
    );
    for (let sender = 0; sender < 5; sender++) {
      await ingress.dispatch(
        envelope(`attacker-${sender}`, {
          type: "message",
          channel_type: "im",
          channel: `D${sender}`,
          user: `U${sender}`,
          text: "ROME-LINK-WRONG000000",
          ts: `1700000010.${sender}`,
        }),
      );
    }
    await ingress.dispatch(
      envelope("guardian-wrong-after-burst", {
        type: "message",
        channel_type: "im",
        channel: "D-GUARDIAN",
        user: "UGUARDIAN",
        text: "ROME-LINK-WRONG000000",
        ts: "guardian-wrong-after-burst",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected).toHaveBeenCalledTimes(6);

    for (let sender = 5; sender <= 100; sender++) {
      await ingress.dispatch(
        envelope(`attacker-${sender}`, {
          type: "message",
          channel_type: "im",
          channel: `D${sender}`,
          user: `U${sender}`,
          text: "ROME-LINK-WRONG000000",
          ts: `1700000010.${sender}`,
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Each tracked sender gets one response even after the global burst cap,
    // while the sender map and total feedback remain bounded.
    expect(rejected).toHaveBeenCalledTimes(100);

    await ingress.dispatch(
      envelope("guardian-after-flood", {
        type: "message",
        channel_type: "im",
        channel: "DGUARDIAN",
        user: "UGUARDIAN",
        text: "ROME-LINK-ABCDEFGH",
        ts: "1700000011.0",
      }),
    );

    await expect(linking).resolves.toEqual({ channelUserId: "T123/UGUARDIAN" });
  });

  it("invalidates setup after a bounded total of untracked incorrect attempts", async () => {
    const ingress = new SlackIngress("secret");
    const linking = waitForSlackGuardianLink(
      ingress,
      identity,
      "ROME-LINK-ABCDEFGH",
      new AbortController().signal,
    );
    const rejection = expect(linking).rejects.toThrow("Too many incorrect");

    for (let attempt = 0; attempt < 500; attempt++) {
      await ingress.dispatch(
        envelope(`distributed-guess-${attempt}`, {
          type: "message",
          channel_type: "im",
          channel: `D${attempt}`,
          user: `U${attempt}`,
          text: "ROME-LINK-WRONG000000",
          ts: `1700000011.${attempt}`,
        }),
      );
    }

    await rejection;
  });

  it("expires and unregisters a guardian-link code", async () => {
    const ingress = new SlackIngress("secret", { startupGraceMs: 0 });
    const controller = new AbortController();
    const linking = waitForSlackGuardianLink(
      ingress,
      identity,
      "ROME-LINK-ABCDEFGH",
      controller.signal,
      { expiresInMs: 5 },
    );

    await expect(linking).rejects.toThrow("expired");
    ingress.completeInitialRegistration();
    await expect(
      ingress.dispatch(
        envelope("expired-code", {
          type: "message",
          channel_type: "im",
          channel: "D1",
          user: "U1",
          text: "ROME-LINK-ABCDEFGH",
          ts: "1700000012.0",
        }),
      ),
    ).resolves.toBe("unhandled");
  });

  it("cancels and unregisters guardian linking when setup is aborted", async () => {
    const ingress = new SlackIngress("secret", { startupGraceMs: 0 });
    const controller = new AbortController();
    const linking = waitForSlackGuardianLink(
      ingress,
      identity,
      "ROME-LINK-ABCDEFGH",
      controller.signal,
    );

    controller.abort(new Error("setup replaced"));
    await expect(linking).rejects.toThrow("setup replaced");
    ingress.completeInitialRegistration();
    await expect(
      ingress.dispatch(
        envelope("cancelled-code", {
          type: "message",
          channel_type: "im",
          channel: "D1",
          user: "U1",
          text: "ROME-LINK-ABCDEFGH",
          ts: "1700000013.0",
        }),
      ),
    ).resolves.toBe("unhandled");
  });

  it("rejects a guardian code delivered by a different Slack application", async () => {
    const ingress = new SlackIngress("secret");
    const controller = new AbortController();
    const linking = waitForSlackGuardianLink(
      ingress,
      identity,
      "ROME-LINK-ABCDEFGH",
      controller.signal,
      { expectedAppId: "A-CONNECTED" },
    );
    const rejection = expect(linking).rejects.toThrow("different app");

    await ingress.dispatch({
      ...envelope("wrong-app-code", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "ROME-LINK-ABCDEFGH",
        ts: "1700000014.0",
      }),
      api_app_id: "A-EVENT",
    });

    await rejection;
  });

  it("does not link or count a Slack Connect external author", async () => {
    const ingress = new SlackIngress("secret");
    const controller = new AbortController();
    const onRejectedAttempt = rs.fn(async () => {});
    const linking = waitForSlackGuardianLink(
      ingress,
      identity,
      "ROME-LINK-ABCDEFGH",
      controller.signal,
      { onRejectedAttempt },
    );

    await ingress.dispatch(
      envelope("external-guardian", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        user_team: "T-EXTERNAL",
        source_team: "T-EXTERNAL",
        text: "ROME-LINK-ABCDEFGH",
        ts: "1700000015.0",
      }),
    );
    expect(onRejectedAttempt).not.toHaveBeenCalled();

    await ingress.dispatch(
      envelope("local-guardian", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U2",
        text: "ROME-LINK-ABCDEFGH",
        ts: "1700000015.1",
      }),
    );
    await expect(linking).resolves.toEqual({ channelUserId: "T123/U2" });
  });

  it("reports rejected guardian-code attempts without revealing the expected code", async () => {
    const ingress = new SlackIngress("secret");
    const controller = new AbortController();
    const onRejectedAttempt = rs.fn(async () => {});
    const linking = waitForSlackGuardianLink(
      ingress,
      identity,
      "ROME-LINK-ABCDEFGH",
      controller.signal,
      { maxFailedAttempts: 2, onRejectedAttempt },
    );

    for (let attempt = 1; attempt <= 2; attempt++) {
      await ingress.dispatch(
        envelope(`rejected-${attempt}`, {
          type: "message",
          channel_type: "im",
          channel: "D1",
          user: "U1",
          text: `ROME-LINK-WRONG${attempt}`,
          ts: `1700000016.${attempt}`,
        }),
      );
    }
    expect(onRejectedAttempt).toHaveBeenNthCalledWith(1, {
      channelId: "D1",
      attempts: 1,
      maxAttempts: 2,
      locked: false,
    });
    expect(onRejectedAttempt).toHaveBeenNthCalledWith(2, {
      channelId: "D1",
      attempts: 2,
      maxAttempts: 2,
      locked: true,
    });
    controller.abort(new Error("test complete"));
    await expect(linking).rejects.toThrow("test complete");
  });

  it("does not await rejected-code feedback and contains feedback failures", async () => {
    const ingress = new SlackIngress("secret");
    const controller = new AbortController();
    let rejectFeedback!: (reason: Error) => void;
    const feedback = new Promise<void>((_resolve, reject) => {
      rejectFeedback = reject;
    });
    const onRejectedAttempt = rs.fn(() => feedback);
    const linking = waitForSlackGuardianLink(
      ingress,
      identity,
      "ROME-LINK-ABCDEFGH",
      controller.signal,
      { onRejectedAttempt },
    );

    const dispatch = ingress.dispatch(
      envelope("non-blocking-rejection", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "ROME-LINK-WRONG000000",
        ts: "1700000017.0",
      }),
    );
    await expect(
      Promise.race([
        dispatch,
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
      ]),
    ).resolves.toBe("delivered");
    expect(onRejectedAttempt).toHaveBeenCalledTimes(1);

    rejectFeedback(new Error("Slack feedback failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      ingress.dispatch(
        envelope("correct-after-feedback-failure", {
          type: "message",
          channel_type: "im",
          channel: "D1",
          user: "U1",
          text: "ROME-LINK-ABCDEFGH",
          ts: "1700000017.1",
        }),
      ),
    ).resolves.toBe("delivered");
    await expect(linking).resolves.toEqual({ channelUserId: "T123/U1" });
  });
});
