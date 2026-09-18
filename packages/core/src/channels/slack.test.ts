import { createHmac } from "node:crypto";
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
        text: "hello",
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
        text: "<@UBOT> help me",
        ts: "1700000000.300",
      }),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      conversationId: "D1",
      senderId: "T123/U1",
      text: "hello",
      addressing: "direct",
      thread: { kind: "dm" },
    });
    expect(messages[0]?.senderDisplayName).toBeUndefined();
    expect(messages[1]).toMatchObject({
      conversationId: "C1:1700000000.300",
      parentConversationId: "C1",
      senderId: "T123/U2",
      text: "help me",
      addressing: "mention",
      thread: { kind: "topic" },
    });
    expect(messages[1]?.senderDisplayName).toBeUndefined();
    expect(messages[1]?.thread).toEqual({ kind: "topic" });
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

  it("posts channel answers in the addressed thread and DMs inline", async () => {
    const ingress = new SlackIngress("secret");
    const { api, postMessage } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });
    await adapter.start();

    await adapter.send(slackThreadConversationId("C1", "1700000000.300"), { text: "answer" });
    await adapter.send("D1" as never, { text: "private answer" });

    expect(postMessage).toHaveBeenNthCalledWith(1, "xoxb-test", {
      channel: "C1",
      text: "answer",
      threadTs: "1700000000.300",
    });
    expect(postMessage).toHaveBeenNthCalledWith(2, "xoxb-test", {
      channel: "D1",
      text: "private answer",
      threadTs: undefined,
    });
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
      await expect(
        slackWebApi.postMessage("xoxb-test", { channel: "D1", text: "hello" }),
      ).resolves.toEqual({ ts: "reply.1" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects attachment-only output instead of reporting a silent success", async () => {
    const ingress = new SlackIngress("secret");
    const { api, postMessage } = fakeApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-test", ingress, api });

    await expect(
      adapter.send("D1" as never, {
        attachments: [{ type: "image", source: "file:///tmp/image.png" }],
      }),
    ).rejects.toThrow("text output only");
    expect(postMessage).not.toHaveBeenCalled();
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
        text: "ROME-LINK-ABCDEFGH",
        ts: "1700000011.1",
      }),
    );
    await expect(linking).resolves.toEqual({ channelUserId: "T123/U2" });
    expect(fallback).not.toHaveBeenCalled();
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
});
