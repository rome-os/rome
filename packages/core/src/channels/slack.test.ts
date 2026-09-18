import { createHmac } from "node:crypto";
import { describe, expect, it, rs } from "@rstest/core";
import {
  SlackAdapter,
  SlackIngress,
  parseSlackConversationId,
  slackThreadConversationId,
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
    const ingress = new SlackIngress("secret");
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
    expect(messages[1]).toMatchObject({
      conversationId: "C1:1700000000.300",
      parentConversationId: "C1",
      senderId: "T123/U2",
      text: "help me",
      addressing: "mention",
      thread: { kind: "topic" },
    });
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
