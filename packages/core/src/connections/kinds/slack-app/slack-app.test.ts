import type { ChannelMessage } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import {
  FORWARD_SIGNATURE_HEADER,
  FORWARD_TEAM_HEADER,
  FORWARD_TIMESTAMP_HEADER,
  forwardSignature,
} from "./forward.js";
import { type MailboxFrame, type OpenMailbox, SlackAppAdapter } from "./slack-app.js";
import { createSlackAppWebApi, type SlackAppWebApi } from "./web-api.js";
import { createTestDb } from "../../../test/db.js";
import { SlackMessageCopyRepository } from "./message-copy.js";
import { slackMessage, type SlackWireMessage } from "./message.js";
import { SlackApiError } from "../slack/slack.js";
import { SlackReadGate } from "./read-gate.js";
import { slackAppMessages, slackAppTimeline } from "../../../db/schema.js";

/** The connection's copy, in a database of its own. */
function testCopy(): SlackMessageCopyRepository {
  return new SlackMessageCopyRepository(createTestDb().db);
}

const TEAM = "T_A";
const BOT = "U_BOT";
const SECRET = "forward-secret-a";

function fakeApi(overrides: Partial<SlackAppWebApi> = {}): SlackAppWebApi {
  return {
    authTest: rs.fn(async () => ({ teamId: TEAM, botUserId: BOT, appId: "A_ROME" })),
    postMessage: rs.fn(async () => ({ ts: "2.0" })),
    openDirectMessage: rs.fn(async () => "D_NEW"),
    userName: rs.fn(async () => ({ displayName: "Ouou", username: "ouou" })),
    conversationHistory: rs.fn(async () => ({ messages: [], hasMore: false })),
    revoke: rs.fn(async () => {}),
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

function adapter(
  mailbox: ReturnType<typeof fakeMailbox>,
  api = fakeApi(),
  copy: SlackMessageCopyRepository = testCopy(),
  now?: () => Date,
  readGate?: SlackReadGate,
) {
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
    copy,
    ...(now ? { now } : {}),
    ...(readGate ? { readGate } : {}),
  });
  a.onInbound((message) => delivered.push(message));
  return { adapter: a, delivered, faults, api, copy };
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
    const api = fakeApi();
    const { adapter: a, faults } = adapter(mailbox, api);
    await a.start();
    api.authTest = rs.fn(async () => {
      throw new SlackApiError("invalid_auth");
    });
    await mailbox.deposit(frame({ ...dmEvent(1), event: { type: "app_uninstalled" } }));
    expect(faults).toEqual(["credential"]);
  });

  describe("looks at the token again 30 s after a removal event it outlived", () => {
    beforeEach(() => {
      rs.useFakeTimers();
    });
    afterEach(() => {
      rs.useRealTimers();
    });

    it("reports the removal once Slack refuses the token", async () => {
      const mailbox = fakeMailbox();
      const api = fakeApi();
      const { adapter: a, faults } = adapter(mailbox, api);
      await a.start();
      // Slack reports the removal before it takes back the token.
      await mailbox.deposit(frame({ ...dmEvent(1), event: { type: "app_uninstalled" } }));
      expect(faults).toEqual([]);
      api.authTest = rs.fn(async () => {
        throw new SlackApiError("token_revoked");
      });
      await rs.advanceTimersByTimeAsync(30_000);
      expect(faults).toEqual(["credential"]);
    });

    it("stays working while the token does", async () => {
      const mailbox = fakeMailbox();
      const api = fakeApi();
      const { adapter: a, faults } = adapter(mailbox, api);
      await a.start();
      await mailbox.deposit(frame({ ...dmEvent(1), event: { type: "app_uninstalled" } }));
      const checks = (api.authTest as ReturnType<typeof rs.fn>).mock.calls.length;
      await rs.advanceTimersByTimeAsync(30_000);
      expect((api.authTest as ReturnType<typeof rs.fn>).mock.calls.length).toBe(checks + 1);
      expect(faults).toEqual([]);
    });

    it("looks no more once the connection stops", async () => {
      const mailbox = fakeMailbox();
      const api = fakeApi();
      const { adapter: a, faults } = adapter(mailbox, api);
      await a.start();
      await mailbox.deposit(frame({ ...dmEvent(1), event: { type: "app_uninstalled" } }));
      await a.stop();
      api.authTest = rs.fn(async () => {
        throw new SlackApiError("token_revoked");
      });
      await rs.advanceTimersByTimeAsync(30_000);
      expect(api.authTest).not.toHaveBeenCalled();
      expect(faults).toEqual([]);
    });
  });

  it("keeps a connection whose new token outlived a removal that waited in the mailbox, and hears what follows", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, faults, delivered } = adapter(mailbox);
    await a.start();
    await mailbox.deposit(
      frame({ ...dmEvent(1), event_id: "Ev_old1", event: { type: "app_uninstalled" } }),
      frame({
        ...dmEvent(2),
        event_id: "Ev_old2",
        event: { type: "tokens_revoked", tokens: { bot: [BOT] } },
      }),
      frame(dmEvent(3)),
    );
    expect(faults).toEqual([]);
    // The direct message after a repair is heard, as the first one after it.
    expect(delivered.map((m) => m.text)).toEqual(["message 3"]);
  });
});

function mentionEvent(i: number, event: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: TEAM,
    api_app_id: "A_ROME",
    event_id: `EvM${i}`,
    event: {
      type: "app_mention",
      channel_type: "channel",
      channel: "C_TEAM",
      user: "U_MEMBER",
      text: `<@${BOT}> question ${i}`,
      ts: `1700000100.${String(i).padStart(6, "0")}`,
      ...event,
    },
  };
}

describe("Slack app mentions in a group (R5)", () => {
  it("hands over 10 of 10 mentions once each, as a mention in the group", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    for (let i = 0; i < 10; i++) await mailbox.deposit(frame(mentionEvent(i)));
    for (let i = 0; i < 10; i++) await mailbox.deposit(frame(mentionEvent(i)));

    expect(delivered).toHaveLength(10);
    expect(new Set(delivered.map((m) => m.messageId)).size).toBe(10);
    for (const [i, message] of delivered.entries()) {
      expect(message).toMatchObject({
        chatId: "C_TEAM",
        senderId: "T_A/U_MEMBER",
        text: `question ${i}`,
        thread: { kind: "group" },
        addressing: "mention",
      });
    }
  });

  it("replies in a thread under the mention", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered, api } = adapter(mailbox);
    await a.start();
    await mailbox.deposit(frame(mentionEvent(1)));
    const mention = delivered[0];

    await a.send(mention.chatId, { text: "answer", replyToMessageId: mention.messageId } as never);
    expect(api.postMessage).toHaveBeenCalledWith(
      "xoxb-a",
      { channel: "C_TEAM", markdown: "answer", threadTs: "1700000100.000001" },
      expect.anything(),
    );
  });

  it("answers a mention inside an existing thread in that thread", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered, api } = adapter(mailbox);
    await a.start();
    await mailbox.deposit(frame(mentionEvent(2, { thread_ts: "1700000050.000000" })));
    const mention = delivered[0];
    expect(mention.replyTo).toEqual({ messageId: "1700000050.000000" });

    await a.send(mention.chatId, { text: "answer", replyToMessageId: mention.messageId } as never);
    expect(api.postMessage).toHaveBeenCalledWith(
      "xoxb-a",
      { channel: "C_TEAM", markdown: "answer", threadTs: "1700000050.000000" },
      expect.anything(),
    );
  });

  it("hears a message that is only its mention, in the group and in a thread", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    await mailbox.deposit(
      frame(mentionEvent(1, { text: `<@${BOT}>` })),
      frame(mentionEvent(2, { text: ` <@${BOT}> `, thread_ts: "1700000100.000001" })),
    );
    expect(delivered.map((m) => m.text)).toEqual(["@Rome", "@Rome"]);
  });

  it("neither answers nor keeps a group message that does not mention it", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered, copy } = adapter(mailbox);
    await a.start();
    const unmentioned = mentionEvent(3, { type: "message", text: "lunch?" });
    await mailbox.deposit(frame(unmentioned));

    expect(mailbox.statuses).toEqual([200]);
    expect(delivered).toHaveLength(0);
    expect(copy.mayNotHold(TEAM, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("hands a mention over again on start when Rome may not hold it", async () => {
    const mailbox = fakeMailbox();
    const copy = testCopy();
    const first = adapter(mailbox, fakeApi(), copy);
    first.adapter.onInbound(() => {
      throw new Error("Rome is busy");
    });
    await first.adapter.start();
    await mailbox.deposit(frame(mentionEvent(4)));
    await first.adapter.stop();

    const second = adapter(mailbox, fakeApi(), copy);
    await second.adapter.start();
    expect(second.delivered.map((m) => m.text)).toEqual(["question 4"]);
  });
});

describe("Slack app events for its own posts", () => {
  it("hands over no event for its own post in a direct message, sends nothing, and keeps it only in the chat's timeline", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered, api, copy } = adapter(mailbox);
    await a.start();
    const own = dmEvent(5, {});
    await mailbox.deposit(
      frame({ ...own, event: { ...own.event, user: BOT, bot_id: "B_ROME", text: "Rome's reply" } }),
    );

    expect(mailbox.statuses).toEqual([200]);
    expect(delivered).toHaveLength(0);
    expect(api.postMessage).not.toHaveBeenCalled();
    // Not kept as a message to hand over: a restart hands over nothing.
    expect(copy.mayNotHold(TEAM, Number.MAX_SAFE_INTEGER)).toEqual([]);
    // Kept in the chat's timeline, as the post it is.
    expect(copy.timelineRow(TEAM, "D_GUARDIAN", own.event.ts)?.message).toMatchObject({
      direction: "outbound",
      text: "Rome's reply",
    });
  });

  it("drops its own post in a group, and still hears another bot that mentions it", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    await mailbox.deposit(
      frame(mentionEvent(7, { user: BOT, bot_id: "B_ROME" })),
      frame(mentionEvent(8, { user: "U_OTHER_BOT", bot_id: "B_OTHER" })),
    );
    expect(delivered.map((m) => m.senderId)).toEqual(["T_A/U_OTHER_BOT"]);
  });

  it("hears a workflow's mention, which Slack sends as a bot_message with no user", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    const event = mentionEvent(9, { subtype: "bot_message", bot_id: "B_WORKFLOW" });
    delete (event.event as { user?: string }).user;
    await mailbox.deposit(frame(event));
    expect(delivered.map((m) => m.senderId)).toEqual(["T_A/B_WORKFLOW"]);
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

describe("Slack app's own copy of its direct messages", () => {
  const at = (minute: number) => () => new Date(Date.UTC(2026, 10, 19, 12, minute));

  it("tells the mailbox a message arrived only once its copy holds it", async () => {
    const mailbox = fakeMailbox();
    const copy = testCopy();
    const keep = copy.keep.bind(copy);
    let failing = true;
    copy.keep = (kept, when) => {
      if (failing) throw new Error("disk full");
      return keep(kept, when);
    };
    const { adapter: a, delivered, faults } = adapter(mailbox, fakeApi(), copy);
    await a.start();

    await mailbox.deposit(frame(dmEvent(1)));
    expect(mailbox.statuses).toEqual([500]);
    expect(delivered).toHaveLength(0);
    // The drain stops retrying a frame after a few tries, so the connection is
    // reported down and starts again with a fresh drain.
    expect(faults).toEqual(["transport"]);

    // The mailbox kept the frame and delivers it again.
    failing = false;
    await mailbox.deposit();
    expect(mailbox.statuses).toEqual([500, 200]);
    expect(delivered.map((m) => m.text)).toEqual(["message 1"]);
  });

  it("hands Rome on start what it kept but never handed over", async () => {
    const { db } = createTestDb();
    // Kept, then stopped before noting it was handed over.
    const interrupted = new SlackMessageCopyRepository(db);
    interrupted.handedOver = () => {};
    const first = adapter(fakeMailbox(), fakeApi(), interrupted, at(0));
    await first.adapter.start();
    await first.adapter.handleFrame(frame(dmEvent(1)));
    await first.adapter.stop();

    const copy = new SlackMessageCopyRepository(db);
    const restarted = adapter(fakeMailbox(), fakeApi(), copy, at(30));
    await restarted.adapter.start();
    expect(restarted.delivered.map((m) => m.text)).toEqual(["message 1"]);
    expect(restarted.delivered[0]?.timestamp).toEqual(first.delivered[0]?.timestamp);

    // Each start offers the last hand-offs again; Rome ignores what it holds.
    const again = adapter(fakeMailbox(), fakeApi(), copy, at(50));
    await again.adapter.start();
    expect(again.delivered.map((m) => m.text)).toEqual(["message 1"]);
  });

  it("hands Rome again on start what it handed over just before a stop, however long the stop", async () => {
    const { db } = createTestDb();
    const copy = new SlackMessageCopyRepository(db);
    const first = adapter(fakeMailbox(), fakeApi(), copy, at(0));
    await first.adapter.start();
    await first.adapter.handleFrame(frame(dmEvent(1)));
    await first.adapter.stop();

    // A reload a minute later: Rome may not have recorded it yet.
    const reloaded = adapter(fakeMailbox(), fakeApi(), copy, at(1));
    await reloaded.adapter.start();
    expect(reloaded.delivered.map((m) => m.text)).toEqual(["message 1"]);

    // A restart hours later still hands over what came just before the stop.
    const late = adapter(
      fakeMailbox(),
      fakeApi(),
      copy,
      () => new Date(Date.UTC(2026, 10, 19, 15)),
    );
    await late.adapter.start();
    expect(late.delivered.map((m) => m.text)).toEqual(["message 1"]);
  });

  it("hands Rome again only what came just before the last hand-off", async () => {
    const { db } = createTestDb();
    const copy = new SlackMessageCopyRepository(db);
    const first = adapter(fakeMailbox(), fakeApi(), copy, at(0));
    await first.adapter.start();
    await first.adapter.handleFrame(frame(dmEvent(1)));
    await first.adapter.stop();
    const second = adapter(fakeMailbox(), fakeApi(), copy, at(40));
    await second.adapter.start();
    await second.adapter.handleFrame(frame(dmEvent(2)));
    await second.adapter.stop();

    // Message 1 was handed over 40 minutes before the last hand-off.
    const restarted = adapter(fakeMailbox(), fakeApi(), copy, at(50));
    await restarted.adapter.start();
    expect(restarted.delivered.map((m) => m.text)).toEqual(["message 2"]);
  });

  it("hands over a message Slack delivers again after a restart only once", async () => {
    const mailbox = fakeMailbox();
    const copy = testCopy();
    const first = adapter(mailbox, fakeApi(), copy, at(0));
    await first.adapter.start();
    await mailbox.deposit(frame(dmEvent(1)));
    await first.adapter.stop();

    const restarted = adapter(mailbox, fakeApi(), copy, at(30));
    await restarted.adapter.start();
    // Start offers it again, since a stop may have cut it off before Rome
    // recorded it; Slack's own redelivery adds nothing on top.
    expect(restarted.delivered.map((m) => m.text)).toEqual(["message 1"]);
    await mailbox.deposit(frame(dmEvent(1)));
    expect(first.delivered).toHaveLength(1);
    expect(restarted.delivered).toHaveLength(1);
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

describe("Slack app mailbox key", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 10, 19);
  const keyExpiringAt = (ms: number, tag = "sig") => `${Math.floor(ms / 1000)}.${tag}`;

  function renewing(
    stored: string,
    refresh: () => Promise<{ connectUrl: string; drainKey: string }>,
  ) {
    const opened: string[] = [];
    const stopped: string[] = [];
    const faults: string[] = [];
    const refreshed: string[] = [];
    const open: OpenMailbox = (mailbox) => {
      opened.push(mailbox.drainKey);
      return { stop: () => void stopped.push(mailbox.drainKey) };
    };
    const a = new SlackAppAdapter({
      channel: "slack_app",
      botToken: "xoxb-a",
      teamId: TEAM,
      botUserId: BOT,
      forwardSecret: SECRET,
      mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: stored },
      api: fakeApi(),
      openMailbox: open,
      refreshMailbox: rs.fn(refresh),
      onMailboxRefreshed: (mailbox) => refreshed.push(mailbox.drainKey),
      onFault: ({ kind }) => faults.push(kind),
      copy: testCopy(),
    });
    return { adapter: a, opened, stopped, faults, refreshed };
  }

  async function withClock(run: () => Promise<void>) {
    rs.useFakeTimers();
    rs.setSystemTime(NOW);
    try {
      await run();
    } finally {
      rs.useRealTimers();
    }
  }

  it("refuses to drain with an expired key it could not renew, and drains once Rome Cloud recovers", () =>
    withClock(async () => {
      const expired = keyExpiringAt(NOW - DAY);
      const fresh = keyExpiringAt(NOW + 90 * DAY, "fresh");
      let cloudUp = false;
      const t = renewing(expired, async () => {
        if (!cloudUp) throw new Error("Rome Cloud unreachable");
        return { connectUrl: "wss://relay.test/c/mbx", drainKey: fresh };
      });
      await expect(t.adapter.start()).rejects.toThrow("expired");
      expect(t.opened).toEqual([]);
      // The runtime restarts the connection after a Disconnected fault.
      cloudUp = true;
      await t.adapter.start();
      expect(t.opened).toEqual([fresh]);
      expect(t.refreshed).toEqual([fresh]);
      await t.adapter.stop();
    }));

  it("renews the key a week before it expires and reopens the drain with it", () =>
    withClock(async () => {
      const first = keyExpiringAt(NOW + 30 * DAY, "first");
      const second = keyExpiringAt(NOW + 120 * DAY, "second");
      let answer = first;
      const t = renewing(first, async () => ({
        connectUrl: "wss://relay.test/c/mbx",
        drainKey: answer,
      }));
      await t.adapter.start();
      expect(t.opened).toEqual([first]);
      answer = second;
      await rs.advanceTimersByTimeAsync(22 * DAY);
      expect(t.opened).toEqual([first]);
      await rs.advanceTimersByTimeAsync(1 * DAY + 1000);
      expect(t.opened).toEqual([first, second]);
      expect(t.stopped).toEqual([first]);
      expect(t.refreshed).toEqual([second]);
      expect(t.faults).toEqual([]);
      await t.adapter.stop();
    }));

  it("lets the old drain finish its message before the renewed drain opens", () =>
    withClock(async () => {
      const first = keyExpiringAt(NOW + 8 * DAY, "first");
      const second = keyExpiringAt(NOW + 98 * DAY, "second");
      let releaseName!: () => void;
      const nameHeld = new Promise<void>((resolve) => {
        releaseName = resolve;
      });
      const order: string[] = [];
      let inFlight: Promise<unknown> = Promise.resolve();
      // Like the relay drainer, stopping waits for the delivery in flight.
      const open: OpenMailbox = (mailbox, onFrame) => {
        order.push(`open ${mailbox.drainKey.split(".")[1]}`);
        if (mailbox.drainKey === first) inFlight = onFrame(frame(dmEvent(1)));
        return {
          stop: async () => {
            await inFlight;
            order.push(`stopped ${mailbox.drainKey.split(".")[1]}`);
          },
        };
      };
      let answer = first;
      const a = new SlackAppAdapter({
        channel: "slack_app",
        botToken: "xoxb-a",
        teamId: TEAM,
        botUserId: BOT,
        forwardSecret: SECRET,
        mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: first },
        api: fakeApi({
          userName: rs.fn(async () => {
            await nameHeld;
            return { displayName: "Ouou" };
          }),
        }),
        openMailbox: open,
        refreshMailbox: async () => ({ connectUrl: "wss://relay.test/c/mbx", drainKey: answer }),
        copy: testCopy(),
      });
      a.onInbound((message) => order.push(`delivered ${message.text}`));
      await a.start();
      answer = second;
      await rs.advanceTimersByTimeAsync(DAY + 1000);
      expect(order).toEqual(["open first"]);
      releaseName();
      await rs.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["open first", "delivered message 1", "stopped first", "open second"]);
      await a.stop();
    }));

  it("drops a refresh that answers after the adapter stopped, without persisting it", async () => {
    const stored = "k-stored";
    let answer!: (mailbox: { connectUrl: string; drainKey: string }) => void;
    const t = renewing(
      stored,
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const started = t.adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A regrant replaces this adapter while Rome Cloud is still answering.
    await t.adapter.stop();
    answer({ connectUrl: "wss://relay.test/c/mbx", drainKey: "k-late" });
    await started;
    expect(t.refreshed).toEqual([]);
    expect(t.opened).toEqual([]);
  });

  it("retries a failed renewal hourly, and reports the connection down once the key expires", () =>
    withClock(async () => {
      const key = keyExpiringAt(NOW + 7 * DAY + 2 * 60 * 60 * 1000);
      let calls = 0;
      const t = renewing(key, async () => {
        calls++;
        if (calls === 1) return { connectUrl: "wss://relay.test/c/mbx", drainKey: key };
        throw new Error("Rome Cloud unreachable");
      });
      await t.adapter.start();
      await rs.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 1000);
      expect(calls).toBe(2);
      await rs.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      expect(calls).toBe(5);
      expect(t.faults).toEqual([]);
      await rs.advanceTimersByTimeAsync(7 * DAY);
      expect(t.faults).toEqual(["transport"]);
      await t.adapter.stop();
    }));
});

/**
 * Slack's side of one direct message: every message said there, whether or
 * not the instance heard it, answered as conversations.history pages are,
 * newest first, at most `limit` before `latest`.
 */
function fakeSlackHistory() {
  const said: SlackWireMessage[] = [];
  const calls: Array<{ channel: string; latest?: string }> = [];
  const conversationHistory = rs.fn(
    async (_token: string, input: { channel: string; latest?: string; limit: number }) => {
      calls.push({ channel: input.channel, ...(input.latest ? { latest: input.latest } : {}) });
      const older = said
        .filter((m) => input.latest === undefined || Number(m.ts) < Number(input.latest))
        .sort((a, b) => Number(b.ts) - Number(a.ts));
      return { messages: older.slice(0, input.limit), hasMore: older.length > input.limit };
    },
  );
  return {
    calls,
    said,
    conversationHistory,
    /** A message said in Slack, by the member or by Rome's bot. */
    say(i: number, by: "member" | "bot" = "member", ts?: string): SlackWireMessage {
      const message = {
        ts: ts ?? `1700000000.${String(i).padStart(6, "0")}`,
        user: by === "bot" ? BOT : "U_GUARDIAN",
        ...(by === "bot" ? { bot_id: "B_ROME" } : {}),
        text: `message ${i}`,
      };
      said.push(message);
      return message;
    },
  };
}

/** A gate that never waits, so a test reads as often as it likes. */
function openGate(): SlackReadGate {
  return new SlackReadGate({ intervalMs: 0, maxWaitMs: 0 });
}

function historyAdapter(
  mailbox: ReturnType<typeof fakeMailbox>,
  slack: ReturnType<typeof fakeSlackHistory>,
  options: { db?: ReturnType<typeof createTestDb>["db"]; gate?: SlackReadGate } = {},
) {
  const db = options.db ?? createTestDb().db;
  const api = fakeApi({ conversationHistory: slack.conversationHistory });
  return {
    ...adapter(
      mailbox,
      api,
      new SlackMessageCopyRepository(db),
      undefined,
      options.gate ?? openGate(),
    ),
    db,
  };
}

const texts = (messages: ChannelMessage[]) => messages.map((m) => m.text);

describe("Slack app reads a direct message (R13)", () => {
  it("reads from Slack what its copy lacks, then the same from its copy", async () => {
    const slack = fakeSlackHistory();
    for (let i = 1; i <= 10; i++) slack.say(i, i % 2 === 0 ? "bot" : "member");
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();

    const first = await a.readHistory("D_GUARDIAN" as never, { limit: 10 });
    expect(texts(first)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((i) => `message ${i}`));
    expect(first[0]).toMatchObject({ direction: "outbound", senderId: "T_A/U_BOT" });
    expect(first[1]).toMatchObject({
      direction: "inbound",
      senderId: "T_A/U_GUARDIAN",
      senderDisplayName: "Ouou",
      thread: { kind: "dm" },
    });
    expect(slack.calls).toHaveLength(1);

    const again = await a.readHistory("D_GUARDIAN" as never, { limit: 10 });
    expect(again).toEqual(first);
    expect(slack.calls).toHaveLength(1);
  });

  it("answers the same with its copy wiped as with it whole", async () => {
    const slack = fakeSlackHistory();
    for (let i = 1; i <= 12; i++) slack.say(i, i % 3 === 0 ? "bot" : "member");
    const mailbox = fakeMailbox();
    const { adapter: a, db } = historyAdapter(mailbox, slack);
    await a.start();
    const whole = await a.readHistory("D_GUARDIAN" as never, { limit: 12 });

    db.delete(slackAppTimeline).run();
    const wiped = await a.readHistory("D_GUARDIAN" as never, { limit: 12 });
    expect(wiped).toEqual(whole);
    // Paging back from the oldest gives the same messages as well.
    const older = await a.readHistory("D_GUARDIAN" as never, {
      olderThan: "1700000000.000007",
      limit: 3,
    });
    expect(texts(older)).toEqual(["message 6", "message 5", "message 4"]);
  });

  it("forgets a link across a message from another workspace that arrives late", async () => {
    const slack = fakeSlackHistory();
    slack.say(1);
    const mailbox = fakeMailbox();
    const { adapter: a, db } = historyAdapter(mailbox, slack);
    await a.start();
    // A read heads the chat at message 1; then message 3 is heard, and
    // message 2, said before it by someone in another workspace, arrives late.
    await a.readHistory("D_GUARDIAN" as never, { limit: 1 });
    Object.assign(slack.say(2), { user: "U_EXT" });
    slack.say(3);
    await mailbox.deposit(frame(dmEvent(3)));
    const late = dmEvent(2);
    await mailbox.deposit(frame({ ...late, event: { ...late.event, user_team: "T_OTHER" } }));

    const read = await a.readHistory("D_GUARDIAN" as never, {
      olderThan: "1700000000.000003",
      limit: 2,
    });
    db.delete(slackAppTimeline).run();
    const wiped = await a.readHistory("D_GUARDIAN" as never, {
      olderThan: "1700000000.000003",
      limit: 2,
    });

    expect(texts(read)).toEqual(["message 2", "message 1"]);
    expect(read).toEqual(wiped);
  });

  it("reads past a message heard late when a page already kept newer ones", async () => {
    const slack = fakeSlackHistory();
    for (let i = 1; i <= 4; i++) slack.say(i);
    const mailbox = fakeMailbox();
    const { adapter: a, db } = historyAdapter(mailbox, slack);
    await a.start();
    await mailbox.deposit(frame(dmEvent(1)));
    // A page below message 4 keeps 3, 2 and 1; then message 2's event lands.
    await a.readHistory("D_GUARDIAN" as never, { olderThan: "1700000000.000004", limit: 3 });
    await mailbox.deposit(frame(dmEvent(2)));

    const whole = await a.readHistory("D_GUARDIAN" as never, { limit: 1 });
    db.delete(slackAppTimeline).run();
    const wiped = await a.readHistory("D_GUARDIAN" as never, { limit: 1 });

    expect(texts(whole)).toEqual(["message 4"]);
    expect(whole).toEqual(wiped);
  });

  it("reads a message that reached Slack but never the instance", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const db = createTestDb().db;
    const first = historyAdapter(mailbox, slack, { db });
    await first.adapter.start();
    slack.say(1);
    await mailbox.deposit(frame(dmEvent(1)));
    await first.adapter.stop();

    // Said while the instance was away, and lost on the way: never deposited.
    slack.say(2);
    const second = historyAdapter(mailbox, slack, { db });
    await second.adapter.start();
    slack.say(3);
    await mailbox.deposit(frame(dmEvent(3)));

    const read = await second.adapter.readHistory("D_GUARDIAN" as never, { limit: 3 });
    expect(texts(read)).toEqual(["message 3", "message 2", "message 1"]);
  });

  it("links no message to an older one Slack delivers again after a restart", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const db = createTestDb().db;
    const first = historyAdapter(mailbox, slack, { db });
    await first.adapter.start();
    for (const i of [1, 2, 3]) {
      slack.say(i);
      await mailbox.deposit(frame(dmEvent(i)));
    }
    await first.adapter.stop();

    const second = historyAdapter(mailbox, slack, { db });
    await second.adapter.start();
    // Message 1 again, then a new message.
    await mailbox.deposit(frame(dmEvent(1)));
    slack.say(4);
    await mailbox.deposit(frame(dmEvent(4)));

    const read = await second.adapter.readHistory("D_GUARDIAN" as never, { limit: 4 });
    expect(texts(read)).toEqual(["message 4", "message 3", "message 2", "message 1"]);
  });

  it("links no message across one it failed to note", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a, copy } = historyAdapter(mailbox, slack);
    await a.start();
    for (const i of [1, 2, 3]) slack.say(i);
    await mailbox.deposit(frame(dmEvent(1)));
    const keepRun = copy.keepRun.bind(copy);
    const failing = rs.spyOn(copy, "keepRun").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await mailbox.deposit(frame(dmEvent(2)));
    failing.mockImplementation(keepRun);
    await mailbox.deposit(frame(dmEvent(3)));

    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 3 });
    expect(texts(read)).toEqual(["message 3", "message 2", "message 1"]);
  });

  it("links no message across a bot's post with no user, which Slack's history still shows", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    const said = [1, 2, 3].map((i) => slack.say(i));
    Object.assign(said[1], { subtype: "bot_message", bot_id: "B_OTHER", user: undefined });
    const bot = dmEvent(2);
    const { user: _user, ...botEvent } = bot.event as Record<string, unknown>;
    await mailbox.deposit(
      frame(dmEvent(1)),
      frame({ ...bot, event: { ...botEvent, subtype: "bot_message", bot_id: "B_OTHER" } }),
      frame(dmEvent(3)),
    );

    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 3 });
    expect(texts(read)).toEqual(["message 3", "message 2", "message 1"]);
  });

  it("links no message across one from another workspace, which Slack's history still shows", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    for (const i of [1, 2, 3]) slack.say(i);
    const external = dmEvent(2);
    await mailbox.deposit(
      frame(dmEvent(1)),
      frame({ ...external, event: { ...external.event, user_team: "T_OTHER" } }),
      frame(dmEvent(3)),
    );

    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 2 });
    expect(texts(read)).toEqual(["message 3", "message 2"]);
  });

  it("answers a read without the names Slack is slow to give, asking once per author", async () => {
    rs.useFakeTimers();
    try {
      const slack = fakeSlackHistory();
      for (let i = 1; i <= 7; i++) slack.say(i);
      const userName = rs.fn(() => new Promise<never>(() => {}));
      const { adapter: a } = adapter(
        fakeMailbox(),
        fakeApi({ conversationHistory: slack.conversationHistory, userName }),
        testCopy(),
        undefined,
        openGate(),
      );
      await a.start();
      const reading = a.readHistory("D_GUARDIAN" as never, { limit: 7 });
      await rs.advanceTimersByTimeAsync(3_000);
      const read = await reading;
      expect(read).toHaveLength(7);
      expect(read[0]?.senderDisplayName).toBeUndefined();
      expect(userName).toHaveBeenCalledTimes(1);
    } finally {
      rs.useRealTimers();
    }
  });

  it("reads from its copy what it heard and sent in one drain, without asking Slack", async () => {
    const slack = fakeSlackHistory();
    slack.say(1);
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    await a.readHistory("D_GUARDIAN" as never, { limit: 5 });
    expect(slack.calls).toHaveLength(1);

    slack.say(2);
    await mailbox.deposit(frame(dmEvent(2)));
    // Rome's reply, and Slack's event for it.
    const reply = slack.say(3, "bot");
    const api = a as unknown as { config: { api: SlackAppWebApi } };
    (api.config.api.postMessage as ReturnType<typeof rs.fn>).mockResolvedValueOnce({
      ts: reply.ts,
    });
    await a.send("D_GUARDIAN" as never, { text: "message 3" } as never);
    await mailbox.deposit(
      frame({ ...dmEvent(3), event: { ...dmEvent(3).event, user: BOT, bot_id: "B_ROME" } }),
    );

    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 5 });
    expect(texts(read)).toEqual(["message 3", "message 2", "message 1"]);
    expect(slack.calls).toHaveLength(1);
  });

  it("links no message it sent to the one before, until Slack's event for it comes", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a, copy } = historyAdapter(mailbox, slack);
    await a.start();
    slack.say(1);
    await mailbox.deposit(frame(dmEvent(1)));
    // Message 2 is said, and its event is still on the way when Rome posts 3.
    slack.say(2);
    const reply = slack.say(3, "bot");
    const api = a as unknown as { config: { api: SlackAppWebApi } };
    (api.config.api.postMessage as ReturnType<typeof rs.fn>).mockResolvedValueOnce({
      ts: reply.ts,
    });
    await a.send("D_GUARDIAN" as never, { text: "message 3" } as never);
    // The send's answer shows nothing of message 2, so it links nothing.
    expect(copy.timelineRow(TEAM, "D_GUARDIAN", reply.ts)?.prevTs ?? null).toBeNull();
    // Nor does a read before the events come trust the copy's newest.
    const before = await a.readHistory("D_GUARDIAN" as never, { limit: 3 });
    expect(texts(before)).toEqual(["message 3", "message 2", "message 1"]);

    await mailbox.deposit(
      frame(dmEvent(2)),
      frame({ ...dmEvent(3), event: { ...dmEvent(3).event, user: BOT, bot_id: "B_ROME" } }),
    );
    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 3 });
    expect(texts(read)).toEqual(["message 3", "message 2", "message 1"]);
  });

  it("reads from its copy again once a post's event came before Slack's answer to the send", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    slack.say(1);
    await mailbox.deposit(frame(dmEvent(1)));
    // A read asks Slack for the chat's newest once; the drain carries it on.
    await a.readHistory("D_GUARDIAN" as never, { limit: 1 });
    const reply = slack.say(2, "bot");
    const api = a as unknown as { config: { api: SlackAppWebApi } };
    let answer!: (value: { ts: string }) => void;
    (api.config.api.postMessage as ReturnType<typeof rs.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const sending = a.send("D_GUARDIAN" as never, { text: "message 2" } as never);
    await mailbox.deposit(
      frame({ ...dmEvent(2), event: { ...dmEvent(2).event, user: BOT, bot_id: "B_ROME" } }),
    );
    answer({ ts: reply.ts });
    await sending;

    const asked = slack.calls.length;
    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 1 });
    expect(texts(read)).toEqual(["message 2"]);
    expect(slack.calls.length).toBe(asked);
  });

  it("answers a retry into a new drain the same with its copy wiped as whole", async () => {
    const answers: string[][] = [];
    for (const wipe of [false, true]) {
      const slack = fakeSlackHistory();
      for (const i of [1, 2]) slack.say(i);
      const first = fakeMailbox();
      const before = historyAdapter(first, slack);
      await before.adapter.start();
      await first.deposit(frame(dmEvent(1)), frame(dmEvent(2)));
      await before.adapter.stop();
      if (wipe) {
        before.db.delete(slackAppTimeline).run();
      }

      // Slack retries message 1 into the new drain, and nothing new follows.
      const second = fakeMailbox();
      const after = historyAdapter(second, slack, { db: before.db });
      await after.adapter.start();
      await second.deposit(frame(dmEvent(1)));
      answers.push(texts(await after.adapter.readHistory("D_GUARDIAN" as never, { limit: 1 })));
    }
    expect(answers).toEqual([["message 2"], ["message 2"]]);
  });

  it("takes no message Slack sends again after a restart for the chat's newest", async () => {
    const slack = fakeSlackHistory();
    for (const i of [1, 2, 3]) slack.say(i);
    const first = fakeMailbox();
    const before = historyAdapter(first, slack);
    await before.adapter.start();
    await first.deposit(frame(dmEvent(1)), frame(dmEvent(2)), frame(dmEvent(3)));
    await before.adapter.stop();

    // Slack retries message 1 into the new drain, and nothing new follows.
    const second = fakeMailbox();
    const after = historyAdapter(second, slack, { db: before.db });
    await after.adapter.start();
    await second.deposit(frame(dmEvent(1)));

    const read = await after.adapter.readHistory("D_GUARDIAN" as never, { limit: 1 });
    expect(texts(read)).toEqual(["message 3"]);
  });

  it("takes no backlog message older than what the copy holds for the chat's newest", async () => {
    const slack = fakeSlackHistory();
    const said = Array.from({ length: 5 }, (_, i) => slack.say(i + 1));
    const first = fakeMailbox();
    const before = historyAdapter(first, slack);
    await before.adapter.start();
    await first.deposit(frame(dmEvent(4)), frame(dmEvent(5)));
    await before.adapter.stop();

    // After a restart the mailbox hands over message 1, which the copy never held.
    const second = fakeMailbox();
    const after = historyAdapter(second, slack, { db: before.db });
    await after.adapter.start();
    await second.deposit(frame({ ...dmEvent(1), event: { ...dmEvent(1).event, ts: said[0].ts } }));

    const read = await after.adapter.readHistory("D_GUARDIAN" as never, { limit: 1 });
    expect(texts(read)).toEqual(["message 5"]);
  });

  it("asks Slack again after a message heard out of order", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    for (const i of [1, 2, 3]) slack.say(i);
    await mailbox.deposit(frame(dmEvent(1)));
    // Slack retried message 2 later than it sent message 3.
    await mailbox.deposit(frame(dmEvent(3)));
    await mailbox.deposit(frame(dmEvent(2)));

    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 3 });
    expect(texts(read)).toEqual(["message 3", "message 2", "message 1"]);
  });

  it("moves the drain on past a message a page brought before its event", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a, copy } = historyAdapter(mailbox, slack);
    await a.start();
    const said = [slack.say(1)];
    await mailbox.deposit(frame(dmEvent(1)));
    // A read asks Slack for the chat's newest once; the drain carries it on.
    await a.readHistory("D_GUARDIAN" as never, { limit: 1 });
    said.push(slack.say(2), slack.say(3));
    // Message 2 reached the copy from a page of Slack's, with no link yet.
    const context = { channel: "slack_app", teamId: TEAM, botUserId: BOT, chatId: "D_GUARDIAN" };
    copy.keepRun(TEAM, "D_GUARDIAN", {
      messages: [{ ts: said[1].ts, message: slackMessage(context, said[1])! }],
      before: null,
    });
    await mailbox.deposit(frame(dmEvent(2)), frame(dmEvent(3)));

    expect(copy.timelineRow(TEAM, "D_GUARDIAN", said[2].ts)?.prevTs).toBe(said[1].ts);
    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 3 });
    expect(texts(read)).toEqual(["message 3", "message 2", "message 1"]);
  });

  it("links no message across one a page brought before a late event", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a, copy } = historyAdapter(mailbox, slack);
    await a.start();
    const said = [1, 2, 3].map((i) => slack.say(i));
    await mailbox.deposit(frame(dmEvent(1)));
    // Message 2 reached the copy from a page of Slack's; its event comes late.
    const context = { channel: "slack_app", teamId: TEAM, botUserId: BOT, chatId: "D_GUARDIAN" };
    copy.keepRun(TEAM, "D_GUARDIAN", {
      messages: [{ ts: said[1].ts, message: slackMessage(context, said[1])! }],
      before: null,
    });
    await mailbox.deposit(frame(dmEvent(3)));
    await mailbox.deposit(frame(dmEvent(2)));

    expect(copy.timelineRow(TEAM, "D_GUARDIAN", said[2].ts)?.prevTs).toBeNull();
    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 3 });
    expect(texts(read)).toEqual(["message 3", "message 2", "message 1"]);
  });

  it("says where to read on when a page holds only messages it does not read", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    slack.say(1);
    // Sixteen joins above it: a page of 15 keeps none.
    for (let i = 2; i <= 17; i++) {
      (slack.say(i) as { subtype?: string }).subtype = "channel_join";
    }

    await expect(a.readHistory("D_GUARDIAN" as never, { limit: 15 })).rejects.toThrow(
      "Read on with olderThan=1700000000.000003",
    );
  });

  it("counts toward a forward read's limit only messages within its time bound", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    const said = Array.from({ length: 10 }, (_, i) =>
      slack.say(i + 1, "member", `${1700000000 + i + 1}.000000`),
    );
    for (let i = 1; i <= 10; i++) {
      const event = dmEvent(i);
      await mailbox.deposit(frame({ ...event, event: { ...event.event, ts: said[i - 1].ts } }));
    }

    const read = await a.readHistory("D_GUARDIAN" as never, {
      newerThan: said[0].ts,
      since: new Date((1700000000 + 5) * 1000),
      limit: 2,
    });
    expect(texts(read)).toEqual(["message 6", "message 5"]);
  });

  it("reads forward from a wiped copy when one page reaches the read's time bound", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    const said = Array.from({ length: 30 }, (_, i) =>
      slack.say(i + 1, "member", `${1700000000 + i + 1}.000000`),
    );

    const read = await a.readHistory("D_GUARDIAN" as never, {
      newerThan: said[0].ts,
      since: new Date((1700000000 + 25) * 1000),
      limit: 2,
    });
    expect(texts(read)).toEqual(["message 26", "message 25"]);
  });

  it("reads on from a broadcast reply's id, which names its thread too", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    const said = Array.from({ length: 5 }, (_, i) => slack.say(i + 1));
    Object.assign(said[2], { subtype: "thread_broadcast", thread_ts: said[0].ts });

    const all = await a.readHistory("D_GUARDIAN" as never, { limit: 10 });
    const broadcast = all.find((message) => message.text === "message 3");
    expect(broadcast?.messageId).toBe(`${said[0].ts}:${said[2].ts}`);

    const older = await a.readHistory("D_GUARDIAN" as never, {
      olderThan: broadcast?.messageId,
      limit: 10,
    });
    expect(texts(older)).toEqual(["message 2", "message 1"]);
    const newer = await a.readHistory("D_GUARDIAN" as never, {
      newerThan: broadcast?.messageId,
      limit: 10,
    });
    expect(texts(newer)).toEqual(["message 5", "message 4"]);
  });

  it("reads below its own upper bound when the newest message it holds is past it", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    // One message a second, the newest heard live with nothing known before it.
    for (let i = 1; i <= 20; i++) slack.say(i, "member", `${1700000000 + i}.000000`);
    await mailbox.deposit(
      frame({ ...dmEvent(20), event: { ...dmEvent(20).event, ts: "1700000020.000000" } }),
    );

    const read = await a.readHistory("D_GUARDIAN" as never, {
      until: new Date(1_700_000_005_000),
      limit: 3,
    });
    expect(texts(read)).toEqual(["message 5", "message 4", "message 3"]);
  });

  it("refuses a read of a chat the app may not read, naming it", async () => {
    const mailbox = fakeMailbox();
    const api = fakeApi({
      conversationHistory: rs.fn(async () => {
        throw new SlackApiError("missing_scope");
      }),
    });
    const { adapter: a } = adapter(mailbox, api, testCopy(), undefined, openGate());
    await a.start();
    await expect(a.readHistory("C_TEAM" as never, { limit: 5 })).rejects.toThrow(
      /may not read chat C_TEAM/,
    );
  });
});

describe("Slack app reads take turns with Slack's allowance (R13)", () => {
  it("shares one Slack request between two reads of the same chat", async () => {
    const slack = fakeSlackHistory();
    slack.say(1);
    const mailbox = fakeMailbox();
    const gate = new SlackReadGate({ intervalMs: 60_000, maxWaitMs: 60_000 });
    const { adapter: a } = historyAdapter(mailbox, slack, { gate });
    await a.start();

    const [one, two] = await Promise.all([
      a.readHistory("D_GUARDIAN" as never, { limit: 5 }),
      a.readHistory("D_GUARDIAN" as never, { limit: 5 }),
    ]);
    expect(one).toEqual(two);
    expect(slack.calls).toHaveLength(1);
  });

  it("holds a read up to a minute for Slack's next turn, hearing messages meanwhile, and refuses one that would wait longer", async () => {
    const slack = fakeSlackHistory();
    slack.say(1);
    const mailbox = fakeMailbox();
    let release: () => void = () => {};
    const waits: number[] = [];
    const gate = new SlackReadGate({
      intervalMs: 60_000,
      maxWaitMs: 60_000,
      now: () => 0,
      sleep: (ms) => {
        waits.push(ms);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const { adapter: a, delivered } = historyAdapter(mailbox, slack, { gate });
    await a.start();
    await a.readHistory("D_GUARDIAN" as never, { limit: 5 });

    const waiting = a.readHistory("D_GUARDIAN" as never, {
      olderThan: "1700000000.000050",
      limit: 5,
    });
    await mailbox.settle();
    expect(waits).toEqual([60_000]);
    await expect(a.readHistory("D_OTHER" as never, { limit: 5 })).rejects.toThrow(
      /Try again in 120 seconds/,
    );

    // A message arrives while the read waits, and is handed over once.
    slack.say(2);
    await mailbox.deposit(frame(dmEvent(2)));
    expect(texts(delivered)).toEqual(["message 2"]);

    release();
    expect(texts(await waiting)).toEqual(["message 2", "message 1"]);
    expect(texts(delivered)).toEqual(["message 2"]);
  });
});

describe("Slack app searches what it keeps (R9)", () => {
  it("finds heard mentions and read direct messages, each once, newest first, and says what it covered", async () => {
    const slack = fakeSlackHistory();
    slack.say(1, "member");
    slack.say(2, "bot");
    slack.say(3, "member");
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    await a.handleFrame(frame(dmEvent(3)));
    await a.handleFrame(frame(mentionEvent(7)));
    await a.readHistory("D_GUARDIAN" as never, { limit: 10 });

    const found = await a.search({ text: "MESSAGE", limit: 10 });
    const mentions = await a.search({ text: "question", limit: 10 });

    // Message 3 was both heard and read: it counts once.
    expect(texts(found.messages)).toEqual(["message 3", "message 2", "message 1"]);
    expect(found.messages[1]).toMatchObject({ direction: "outbound" });
    expect(found.coverage).toContain("not a workspace-wide search");
    expect(found.coverage).toContain("before Rome's copy was last cleared");
    expect(texts(mentions.messages)).toEqual(["question 7"]);
  });

  it("searches one chat after a wipe as well as a read of it would, from Slack's newest page", async () => {
    const slack = fakeSlackHistory();
    for (let i = 1; i <= 20; i++) slack.say(i, i % 4 === 0 ? "bot" : "member");
    const mailbox = fakeMailbox();
    const { adapter: a, db } = historyAdapter(mailbox, slack);
    await a.start();
    await a.readHistory("D_GUARDIAN" as never, { limit: 20 });
    const whole = await a.search({ text: "message", chatId: "D_GUARDIAN" as never, limit: 15 });

    db.delete(slackAppTimeline).run();
    db.delete(slackAppMessages).run();
    const wiped = await a.search({ text: "message", chatId: "D_GUARDIAN" as never, limit: 15 });

    expect(texts(wiped.messages)).toEqual(texts(whole.messages));
    expect(texts(wiped.messages)).toEqual(
      Array.from({ length: 15 }, (_, i) => `message ${20 - i}`),
    );
    expect(wiped.coverage).toContain("after reading its newest messages from Slack");
  });

  it("searches across chats only what it holds, with no read of Slack, wiped or not", async () => {
    const slack = fakeSlackHistory();
    for (let i = 1; i <= 5; i++) slack.say(i);
    const mailbox = fakeMailbox();
    const { adapter: a, db } = historyAdapter(mailbox, slack);
    await a.start();
    await a.readHistory("D_GUARDIAN" as never, { limit: 5 });
    const reads = slack.calls.length;

    expect(texts((await a.search({ text: "message", limit: 10 })).messages)).toHaveLength(5);
    db.delete(slackAppTimeline).run();
    const wiped = await a.search({ text: "message", limit: 10 });

    expect(wiped.messages).toEqual([]);
    expect(wiped.coverage).toContain("not a workspace-wide search");
    expect(slack.calls).toHaveLength(reads);
  });

  it("searches a channel it may not read in the mentions it heard", async () => {
    const slack = fakeSlackHistory();
    slack.conversationHistory.mockImplementation(async () => {
      throw new SlackApiError("missing_scope");
    });
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    await a.handleFrame(frame(mentionEvent(1)));

    const found = await a.search({ text: "question", chatId: "C_TEAM" as never, limit: 5 });

    expect(texts(found.messages)).toEqual(["question 1"]);
    expect(found.coverage).toContain("may not read the chat's history");
  });

  it("takes a search's wildcards as plain text", async () => {
    const { adapter: a } = adapter(fakeMailbox());
    await a.start();
    await a.handleFrame(frame(dmEvent(1, { event_id: "EvA" })));
    await a.handleFrame(
      frame({
        ...dmEvent(2),
        event: { ...dmEvent(2).event, text: "50% off_today" },
      }),
    );

    expect(texts((await a.search({ text: "%", limit: 10 })).messages)).toEqual(["50% off_today"]);
    expect(texts((await a.search({ text: "f_t", limit: 10 })).messages)).toEqual(["50% off_today"]);
    expect((await a.search({ text: "x_y", limit: 10 })).messages).toEqual([]);
  });

  it("finds the one old match under many newer messages, folding any script's case", async () => {
    const { adapter: a } = adapter(fakeMailbox());
    await a.start();
    await a.handleFrame(
      frame({ ...dmEvent(1), event: { ...dmEvent(1).event, text: "Réunion de l'Équipe" } }),
    );
    for (let i = 2; i <= 1_200; i++) await a.handleFrame(frame(dmEvent(i)));

    expect(texts((await a.search({ text: "ÉQUIPE", limit: 5 })).messages)).toEqual([
      "Réunion de l'Équipe",
    ]);
    expect(texts((await a.search({ text: "message", limit: 3 })).messages)).toEqual([
      "message 1200",
      "message 1199",
      "message 1198",
    ]);
  });

  it("folds case in any script, however each side's accents were typed", async () => {
    const { adapter: a } = adapter(fakeMailbox());
    await a.start();
    const say = (n: number, text: string) =>
      a.handleFrame(frame({ ...dmEvent(n), event: { ...dmEvent(n).event, text } }));
    await say(1, "Привет, Équipe");
    // "É" typed as E and a combining accent.
    await say(2, "L'E\u0301quipe arrive");

    expect(texts((await a.search({ text: "ПРИВЕТ", limit: 10 })).messages)).toEqual([
      "Привет, Équipe",
    ]);
    expect(texts((await a.search({ text: "équipe", limit: 10 })).messages)).toEqual([
      "L'E\u0301quipe arrive",
      "Привет, Équipe",
    ]);
  });
});

describe("Slack app takes edits and deletions into its copy", () => {
  it("reads and searches a direct message as Slack shows it after an edit and a deletion", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a, db } = historyAdapter(mailbox, slack);
    await a.start();
    for (let i = 1; i <= 3; i++) {
      slack.say(i);
      await mailbox.deposit(frame(dmEvent(i)));
    }
    await a.readHistory("D_GUARDIAN" as never, { limit: 3 });

    // Message 2 is edited and message 3 deleted in Slack, and Slack sends
    // the app an event for each.
    slack.said[1].text = "message 2, edited";
    slack.said.splice(2, 1);
    const changed = dmEvent(4);
    await mailbox.deposit(
      frame({
        ...changed,
        event: {
          type: "message",
          subtype: "message_changed",
          channel_type: "im",
          channel: "D_GUARDIAN",
          ts: "1700000001.000000",
          message: { ...slack.said[1], edited: { user: "U_GUARDIAN", ts: "1700000001.000000" } },
        },
      }),
      frame({
        ...dmEvent(5),
        event: {
          type: "message",
          subtype: "message_deleted",
          channel_type: "im",
          channel: "D_GUARDIAN",
          ts: "1700000002.000000",
          deleted_ts: "1700000000.000003",
        },
      }),
    );

    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 3 });
    expect(texts(read)).toEqual(["message 2, edited", "message 1"]);
    db.delete(slackAppTimeline).run();
    expect(await a.readHistory("D_GUARDIAN" as never, { limit: 3 })).toEqual(read);

    const search = async (text: string) => texts((await a.search({ text, limit: 10 })).messages);
    expect(await search("edited")).toEqual(["message 2, edited"]);
    expect(await search("message 3")).toEqual([]);
    expect(await search("message")).toEqual(["message 2, edited", "message 1"]);
  });

  it("forgets a deleted message's link, so the message after it follows the one before", async () => {
    const slack = fakeSlackHistory();
    for (let i = 1; i <= 4; i++) slack.say(i);
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    await a.readHistory("D_GUARDIAN" as never, { limit: 4 });

    slack.said.splice(1, 1);
    await mailbox.deposit(
      frame({
        ...dmEvent(5),
        event: {
          type: "message",
          subtype: "message_deleted",
          channel_type: "im",
          channel: "D_GUARDIAN",
          ts: "1700000002.000000",
          deleted_ts: "1700000000.000002",
        },
      }),
    );
    const calls = slack.calls.length;
    const read = await a.readHistory("D_GUARDIAN" as never, {
      olderThan: "1700000000.000004",
      limit: 3,
    });
    expect(texts(read)).toEqual(["message 3", "message 1"]);
    expect(slack.calls).toHaveLength(calls);
  });
  /** A change event in the direct message: `message` edited as `text`, or
   *  deleted when `text` is null, at `changedTs`. */
  const changeFrame = (i: number, message: number, text: string | null, changedTs: string) =>
    frame({
      ...dmEvent(i),
      event: {
        type: "message",
        channel_type: "im",
        channel: "D_GUARDIAN",
        ts: changedTs,
        event_ts: changedTs,
        ...(text === null
          ? {
              subtype: "message_deleted",
              deleted_ts: `1700000000.${String(message).padStart(6, "0")}`,
            }
          : {
              subtype: "message_changed",
              message: {
                ts: `1700000000.${String(message).padStart(6, "0")}`,
                user: "U_GUARDIAN",
                text,
                edited: { user: "U_GUARDIAN", ts: changedTs },
              },
            }),
      },
    });

  it("keeps a deleted message gone when Slack retries the event that said it", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = historyAdapter(mailbox, slack);
    await a.start();
    slack.say(1);
    await mailbox.deposit(frame(dmEvent(1)));
    slack.said.splice(0, 1);
    await mailbox.deposit(changeFrame(9, 1, null, "1700000001.000000"));
    // Slack retries the message's own event, after the deletion.
    await mailbox.deposit(frame(dmEvent(1)));

    expect(delivered).toHaveLength(1);
    expect((await a.search({ text: "message", limit: 10 })).messages).toEqual([]);
    expect(await a.readHistory("D_GUARDIAN" as never, { limit: 5 })).toEqual([]);
  });

  it("takes only the newest edit, whatever order Slack delivers edits in", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    slack.say(1);
    await mailbox.deposit(frame(dmEvent(1)));
    await a.readHistory("D_GUARDIAN" as never, { limit: 1 });
    // Edit A, then edit B, then a retry of edit A.
    await mailbox.deposit(
      changeFrame(10, 1, "edit A", "1700000001.000000"),
      changeFrame(11, 1, "edit B", "1700000002.000000"),
      changeFrame(10, 1, "edit A", "1700000001.000000"),
    );
    slack.said[0].text = "edit B";

    const search = async (text: string) => texts((await a.search({ text, limit: 10 })).messages);
    expect(await search("edit")).toEqual(["edit B"]);
    expect(texts(await a.readHistory("D_GUARDIAN" as never, { limit: 1 }))).toEqual(["edit B"]);
  });

  it("searches a message in the text a page read since shows, not the text it heard", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    // Heard as said, then edited in Slack with no edit event the app hears,
    // as in a group, and read from Slack's history since.
    slack.say(1).text = "Launch Friday";
    await mailbox.deposit(
      frame({ ...dmEvent(1), event: { ...dmEvent(1).event, text: "Launch Friday" } }),
    );
    slack.said[0].text = "Launch Monday";
    await a.stop();
    await a.start();
    await a.readHistory("D_GUARDIAN" as never, { limit: 1 });

    const search = async (text: string) => texts((await a.search({ text, limit: 10 })).messages);
    expect(await search("Launch")).toEqual(["Launch Monday"]);
    expect(await search("Friday")).toEqual([]);
  });
  it("keeps a newer edit a page shows over an older one it heard, and over a late retry", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    slack.say(1);
    await mailbox.deposit(frame(dmEvent(1)));
    await mailbox.deposit(changeFrame(10, 1, "edit A", "1700000001.000000"));
    // Slack shows edit B before its event arrives.
    Object.assign(slack.said[0], { text: "edit B", edited: { ts: "1700000002.000000" } });

    const first = await a.readHistory("D_GUARDIAN" as never, { limit: 1 });
    const calls = slack.calls.length;
    const search = async (text: string) => texts((await a.search({ text, limit: 10 })).messages);
    // Read from the copy before edit B's event arrives.
    expect(texts(await a.readHistory("D_GUARDIAN" as never, { limit: 1 }))).toEqual(["edit B"]);
    expect(slack.calls).toHaveLength(calls);
    expect(await search("edit")).toEqual(["edit B"]);
    // A late retry of edit A changes nothing.
    await mailbox.deposit(changeFrame(10, 1, "edit A", "1700000001.000000"));

    expect(texts(first)).toEqual(["edit B"]);
    expect(texts(await a.readHistory("D_GUARDIAN" as never, { limit: 1 }))).toEqual(["edit B"]);
    expect(await search("edit")).toEqual(["edit B"]);
  });
  it("answers a read with an edit or a deletion that arrived while Slack's page was read", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    const reading = rs.fn(
      async (token: string, input: { channel: string; latest?: string; limit: number }) => {
        const page = await slack.conversationHistory(token, input);
        // While the page is in flight, message 2 is edited and message 1 deleted.
        await mailbox.deposit(
          changeFrame(10, 2, "edited while read", "1700000001.000000"),
          changeFrame(11, 1, null, "1700000002.000000"),
        );
        return page;
      },
    );
    const db = createTestDb().db;
    const { adapter: a } = adapter(
      mailbox,
      fakeApi({ conversationHistory: reading }),
      new SlackMessageCopyRepository(db),
      undefined,
      openGate(),
    );
    await a.start();
    slack.say(1);
    slack.say(2);

    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 5 });

    expect(texts(read)).toEqual(["edited while read"]);
  });
  it("answers what the copy gave before Slack's page arrived as the copy holds it after", async () => {
    const slack = fakeSlackHistory();
    const mailbox = fakeMailbox();
    let during: (() => Promise<void>) | undefined;
    const reading = rs.fn(
      async (token: string, input: { channel: string; latest?: string; limit: number }) => {
        const page = await slack.conversationHistory(token, input);
        await during?.();
        return page;
      },
    );
    const db = createTestDb().db;
    const { adapter: a } = adapter(
      mailbox,
      fakeApi({ conversationHistory: reading }),
      new SlackMessageCopyRepository(db),
      undefined,
      openGate(),
    );
    await a.start();
    for (let i = 1; i <= 4; i++) slack.say(i);
    await a.readHistory("D_GUARDIAN" as never, { limit: 4 });
    // The copy no longer knows what comes before message 2, so the next read
    // takes 4, 3 and 2 from the copy and asks Slack below 2. While it does,
    // message 4 is edited and message 3 deleted.
    db.update(slackAppTimeline)
      .set({ prevTs: null })
      .where(eq(slackAppTimeline.ts, "1700000000.000002"))
      .run();
    during = () =>
      mailbox.deposit(
        changeFrame(10, 4, "message 4, edited", "1700000001.000000"),
        changeFrame(11, 3, null, "1700000002.000000"),
      );

    const read = await a.readHistory("D_GUARDIAN" as never, { limit: 4 });

    expect(texts(read)).toEqual(["message 4, edited", "message 2", "message 1"]);
  });

  it("refuses to search one thread, naming the conversation to search", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, fakeSlackHistory());
    await a.start();
    await expect(
      a.search({ text: "x", chatId: "D_GUARDIAN:1700000000.000001" as never, limit: 5 }),
    ).rejects.toThrow(/is a thread.*D_GUARDIAN$/);
  });
});
