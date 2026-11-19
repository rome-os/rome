import type { ChannelMessage } from "@rome-os/app-runtime";
import { describe, expect, it, rs } from "@rstest/core";
import {
  FORWARD_SIGNATURE_HEADER,
  FORWARD_TEAM_HEADER,
  FORWARD_TIMESTAMP_HEADER,
  forwardSignature,
} from "./forward.js";
import { type MailboxFrame, type OpenMailbox, SlackAppAdapter } from "./slack-app.js";
import { createSlackAppWebApi, type SlackAppWebApi } from "./web-api.js";

const TEAM = "T_A";
const BOT = "U_BOT";
const SECRET = "forward-secret-a";

function fakeApi(overrides: Partial<SlackAppWebApi> = {}): SlackAppWebApi {
  return {
    authTest: rs.fn(async () => ({ teamId: TEAM, botUserId: BOT, appId: "A_ROME" })),
    postMessage: rs.fn(async () => ({ ts: "2.0" })),
    openDirectMessage: rs.fn(async () => "D_NEW"),
    userName: rs.fn(async () => ({ displayName: "Ouou", username: "ouou" })),
    ...overrides,
  };
}

function dmEvent(i: number, overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: TEAM,
    api_app_id: "A_ROME",
    event_id: `Ev${i}`,
    event: {
      type: "message",
      channel_type: "im",
      channel: "D_GUARDIAN",
      user: "U_GUARDIAN",
      text: `message ${i}`,
      ts: `1700000000.${String(i).padStart(6, "0")}`,
    },
    ...overrides,
  };
}

/** A frame as Rome Cloud deposits it, signed with `secret` for `team`. */
function frame(payload: unknown, secret = SECRET, team = TEAM): MailboxFrame {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const timestamp = "1700000000";
  return {
    headers: {
      "content-type": "application/json",
      [FORWARD_TEAM_HEADER]: team,
      [FORWARD_TIMESTAMP_HEADER]: timestamp,
      [FORWARD_SIGNATURE_HEADER]: forwardSignature({
        forwardSecret: secret,
        timestamp,
        teamId: team,
        body,
      }),
    },
    body,
  };
}

/**
 * A relay mailbox: frames deposited while nothing drains it wait, and opening
 * a drain replays every frame not yet acknowledged, in order. A frame whose
 * delivery answered 2xx or a terminal 4xx is acknowledged.
 */
function fakeMailbox() {
  const queue: MailboxFrame[] = [];
  let onFrame: ((frame: MailboxFrame) => Promise<{ status: number }>) | null = null;
  const statuses: number[] = [];
  const pump = async () => {
    while (onFrame && queue.length > 0) {
      const { status } = await onFrame(queue[0]);
      statuses.push(status);
      if (status >= 500) return;
      queue.shift();
    }
  };
  const open: OpenMailbox = (_mailbox, handler) => {
    onFrame = handler;
    void pump();
    return {
      stop: () => {
        onFrame = null;
      },
    };
  };
  return {
    open,
    statuses,
    async deposit(...frames: MailboxFrame[]) {
      queue.push(...frames);
      await pump();
    },
    /** Deposit without draining: the instance is stopped. */
    hold(...frames: MailboxFrame[]) {
      queue.push(...frames);
    },
    async settle() {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function adapter(mailbox: ReturnType<typeof fakeMailbox>, api = fakeApi()) {
  const delivered: ChannelMessage[] = [];
  const faults: string[] = [];
  const a = new SlackAppAdapter({
    channel: "slack_app",
    botToken: "xoxb-a",
    teamId: TEAM,
    botUserId: BOT,
    forwardSecret: SECRET,
    mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: "k" },
    api,
    openMailbox: mailbox.open,
    onFault: ({ kind }) => faults.push(kind),
  });
  a.onInbound((message) => delivered.push(message));
  return { adapter: a, delivered, faults, api };
}

describe("Slack app direct messages (R4)", () => {
  it("delivers 20 of 20 direct messages once each, in the direct message they came from", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    for (let i = 0; i < 20; i++) await mailbox.deposit(frame(dmEvent(i)));
    // Slack retries and the relay redelivers: every event arrives again.
    for (let i = 0; i < 20; i++) await mailbox.deposit(frame(dmEvent(i)));

    expect(delivered).toHaveLength(20);
    expect(new Set(delivered.map((m) => m.messageId)).size).toBe(20);
    for (const message of delivered) {
      expect(message).toMatchObject({
        channel: "slack_app",
        chatId: "D_GUARDIAN",
        senderId: "T_A/U_GUARDIAN",
        senderDisplayName: "Ouou",
        thread: { kind: "dm" },
        addressing: "direct",
      });
    }
  });

  it("replies in the same direct message through Slack's Web API", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, api } = adapter(mailbox);
    await a.start();
    const receipt = await a.send("D_GUARDIAN" as never, { text: "hello" } as never);
    expect(api.postMessage).toHaveBeenCalledWith(
      "xoxb-a",
      { channel: "D_GUARDIAN", markdown: "hello", threadTs: undefined },
      expect.anything(),
    );
    expect(receipt).toMatchObject({ chatId: "D_GUARDIAN", messageId: "2.0" });
  });

  it("hears nothing but direct messages from people in the workspace", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    const base = dmEvent(1);
    await mailbox.deposit(
      frame({ ...base, event_id: "E1", event: { ...base.event, user: BOT } }),
      frame({ ...base, event_id: "E2", event: { ...base.event, bot_id: "B1" } }),
      frame({ ...base, event_id: "E3", event: { ...base.event, subtype: "message_changed" } }),
      frame({ ...base, event_id: "E4", event: { ...base.event, user_team: "T_OTHER" } }),
      frame({ ...base, event_id: "E5", event: { ...base.event, type: "app_mention" } }),
    );
    expect(delivered).toHaveLength(0);
  });

  it("refuses to start on a token that answers as another bot", async () => {
    const mailbox = fakeMailbox();
    const api = fakeApi({ authTest: rs.fn(async () => ({ teamId: "T_B", botUserId: BOT })) });
    await expect(adapter(mailbox, api).adapter.start()).rejects.toThrow(/another Slack bot/);
  });

  it("reports a removed app as a refused credential", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, faults } = adapter(mailbox);
    await a.start();
    await mailbox.deposit(frame({ ...dmEvent(1), event: { type: "app_uninstalled" } }));
    expect(faults).toEqual(["credential"]);
  });
});

describe("Slack app while the instance is stopped (R6)", () => {
  it("answers each of 20 messages sent during a stop once, after restart", async () => {
    const mailbox = fakeMailbox();
    const first = adapter(mailbox);
    await first.adapter.start();
    await first.adapter.stop();

    for (let i = 0; i < 20; i++) mailbox.hold(frame(dmEvent(i)));
    // A Slack retry of the same events lands in the mailbox too.
    for (let i = 0; i < 5; i++) mailbox.hold(frame(dmEvent(i)));

    const restarted = adapter(mailbox);
    await restarted.adapter.start();
    await mailbox.settle();
    expect(restarted.delivered.map((m) => m.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `message ${i}`),
    );
  });
});

describe("Slack app frames that did not come from Rome Cloud (R7)", () => {
  it("drops 10 of 10 frames with a bad forward signature", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    for (let i = 0; i < 10; i++) await mailbox.deposit(frame(dmEvent(i), `wrong-${i}`));
    expect(delivered).toHaveLength(0);
    expect(mailbox.statuses).toEqual(Array(10).fill(401));
  });

  it("drops 20 of 20 frames forwarded for another workspace", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    for (let i = 0; i < 10; i++) {
      // Signed for B with B's secret: the header names another workspace.
      await mailbox.deposit(frame({ ...dmEvent(i), team_id: "T_B" }, "secret-b", "T_B"));
      // Signed for A, with a body from B.
      await mailbox.deposit(frame({ ...dmEvent(100 + i), team_id: "T_B" }));
    }
    expect(delivered).toHaveLength(0);
  });
});

describe("Slack app Web API", () => {
  it("calls the configured Slack origin for every method", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({
        ok: true,
        team_id: TEAM,
        user_id: BOT,
        ts: "1.0",
        channel: { id: "D1" },
        user: { name: "n" },
      });
    }) as typeof fetch;
    const api = createSlackAppWebApi("http://fake-slack.test:8080/ignored", fetchImpl);
    await api.authTest("t");
    await api.postMessage("t", { channel: "D1", markdown: "hi" });
    await api.openDirectMessage("t", "U1");
    await api.userName("t", "U1");
    expect(urls.map((url) => new URL(url).origin)).toEqual(
      Array(4).fill("http://fake-slack.test:8080"),
    );
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      "/api/auth.test",
      "/api/chat.postMessage",
      "/api/conversations.open",
      "/api/users.info",
    ]);
  });
});
