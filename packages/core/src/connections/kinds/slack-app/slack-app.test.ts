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
import { slackMessage, type SlackWireMessage } from "./message.js";
import { SlackApiError } from "../slack/slack.js";
import { SlackReadGate } from "./read-gate.js";
import { channelMessageOf } from "../../../chats/connected-accounts/channel-message.js";
import type { Message } from "../../message.js";
import { RecordingStopped } from "../../types.js";

/**
 * Rome's side of a delivery, as Chats takes it: a message is on record once
 * by its id, and a delivery settles once it is. `refusing` makes deliveries
 * reject, as a record that fails or comes too late does.
 */
function fakeChats() {
  const recorded = new Set<string>();
  const delivered: ChannelMessage[] = [];
  const chats = {
    delivered,
    refusing: false,
    accept: async (message: Message): Promise<void> => {
      if (chats.refusing) throw new Error("not recorded within 120000ms");
      if (recorded.has(message.id)) return;
      recorded.add(message.id);
      // What apps receive, so the tests read the fields an app reads.
      delivered.push(channelMessageOf(message, "slack_app"));
    },
  };
  return chats;
}

const TEAM = "T_A";
const BOT = "U_BOT";
const SECRET = "forward-secret-a";
/** How short a real wait may measure: Node's timers and `Date.now()` count
 *  whole milliseconds, so a 300 ms sleep can read as 299. */
const TIMER_SLACK_MS = 5;

function fakeApi(overrides: Partial<SlackAppWebApi> = {}): SlackAppWebApi {
  return {
    authTest: rs.fn(async () => ({ teamId: TEAM, botUserId: BOT, appId: "A_ROME" })),
    postMessage: rs.fn(async () => ({ ts: "2.0" })),
    openDirectMessage: rs.fn(async () => "D_NEW"),
    addReaction: rs.fn(async () => {}),
    removeReaction: rs.fn(async () => {}),
    userName: rs.fn(async () => ({ displayName: "Ouou", username: "ouou" })),
    conversationHistory: rs.fn(async () => ({ messages: [], hasMore: false })),
    conversationReplies: rs.fn(async () => ({ messages: [] })),
    memberChannels: rs.fn(async () => ({ channels: [] })),
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
      attempts: 4,
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
  options: {
    chats?: ReturnType<typeof fakeChats>;
    listened?: () => boolean;
    readGate?: SlackReadGate;
  } = {},
) {
  const chats = options.chats ?? fakeChats();
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
    ...(options.readGate ? { readGate: options.readGate } : {}),
    ...(options.listened ? { listened: options.listened } : {}),
  });
  a.onInbound(chats.accept);
  return { adapter: a, delivered: chats.delivered, faults, api, chats };
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

  it("reacts with Slack's name for the emoji, to the message's own timestamp", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, api } = adapter(mailbox);
    await a.start();
    await a.react("C_TEAM" as never, "1700000000.000100:1700000000.000200", "👍");
    expect(api.addReaction).toHaveBeenCalledWith(
      "xoxb-a",
      { channel: "C_TEAM", timestamp: "1700000000.000200", name: "+1" },
      expect.anything(),
    );
    await expect(a.react("D_GUARDIAN" as never, "1.0", "🦄")).rejects.toThrow("no emoji name");
    await expect(a.react("D_GUARDIAN" as never, "not-a-ts", "👍")).rejects.toThrow(
      "not a Slack message id",
    );
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

  it("does not answer or hand over a group message that does not mention it", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    const unmentioned = mentionEvent(3, { type: "message", text: "lunch?" });
    await mailbox.deposit(frame(unmentioned));

    expect(mailbox.statuses).toEqual([200]);
    expect(delivered).toHaveLength(0);
  });
});

describe("Slack app events for its own posts", () => {
  it("hands over no event for its own post in a direct message, and sends nothing", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered, api } = adapter(mailbox);
    await a.start();
    const own = dmEvent(5, {});
    await mailbox.deposit(
      frame({ ...own, event: { ...own.event, user: BOT, bot_id: "B_ROME", text: "Rome's reply" } }),
    );

    expect(mailbox.statuses).toEqual([200]);
    expect(delivered).toHaveLength(0);
    expect(api.postMessage).not.toHaveBeenCalled();
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

describe("Slack app acknowledging its mailbox", () => {
  it("tells the mailbox a message arrived only once Chats has it on record", async () => {
    const mailbox = fakeMailbox();
    const chats = fakeChats();
    chats.refusing = true;
    const { adapter: a, delivered, faults } = adapter(mailbox, fakeApi(), { chats });
    await a.start();

    await mailbox.deposit(frame(dmEvent(1)));
    expect(mailbox.statuses).toEqual([500]);
    expect(delivered).toHaveLength(0);
    // The drain stops retrying a frame after a few tries, so the connection is
    // reported down and starts again with a fresh drain.
    expect(faults).toEqual(["transport"]);

    // The mailbox kept the frame and delivers it again.
    chats.refusing = false;
    await mailbox.deposit();
    expect(mailbox.statuses).toEqual([500, 200]);
    expect(delivered.map((m) => m.text)).toEqual(["message 1"]);
  });

  it("lets the mailbox deliver again a message refused while recording stopped, without reporting the connection down", async () => {
    const mailbox = fakeMailbox();
    const chats = fakeChats();
    const { adapter: a, delivered, faults } = adapter(mailbox, fakeApi(), { chats });
    let swapping = true;
    a.onInbound(async (message) => {
      if (swapping) throw new RecordingStopped();
      await chats.accept(message);
    });
    await a.start();

    await mailbox.deposit(frame(dmEvent(1)));
    expect(mailbox.statuses).toEqual([500]);
    expect(faults).toEqual([]);

    swapping = false;
    await mailbox.deposit();
    expect(mailbox.statuses).toEqual([500, 200]);
    expect(delivered.map((m) => m.text)).toEqual(["message 1"]);
  });

  it("reports the connection down when recording stays stopped past the drain's retries", async () => {
    const mailbox = fakeMailbox();
    const chats = fakeChats();
    const { adapter: a, delivered, faults } = adapter(mailbox, fakeApi(), { chats });
    let swapping = true;
    a.onInbound(async (message) => {
      if (swapping) throw new RecordingStopped();
      await chats.accept(message);
    });
    await a.start();

    await mailbox.deposit(frame(dmEvent(1)));
    await mailbox.deposit();
    await mailbox.deposit();
    expect(faults).toEqual([]);
    // The drain's fourth and last delivery before it would hold the frame.
    await mailbox.deposit();
    expect(mailbox.statuses).toEqual([500, 500, 500, 500]);
    expect(faults).toEqual(["transport"]);

    // The runtime starts the connection again, with a fresh drain.
    await a.stop();
    swapping = false;
    await a.start();
    await mailbox.settle();
    expect(mailbox.statuses).toEqual([500, 500, 500, 500, 200]);
    expect(delivered.map((m) => m.text)).toEqual(["message 1"]);
  });

  it("answers the mailbox only after the delivery settles", async () => {
    const mailbox = fakeMailbox();
    let settle = () => {};
    const { adapter: a } = adapter(mailbox);
    a.onInbound(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    await a.start();
    const answered = a.handleFrame(frame(dmEvent(1)));
    let status: number | undefined;
    void answered.then((answer) => {
      status = answer.status;
    });
    await mailbox.settle();
    expect(status).toBeUndefined();
    settle();
    await expect(answered).resolves.toEqual({ status: 200 });
  });

  it("hands over nothing heard while Rome does not listen to the account", async () => {
    const mailbox = fakeMailbox();
    let listening = false;
    const { adapter: a, delivered } = adapter(mailbox, fakeApi(), {
      listened: () => listening,
    });
    await a.start();

    await mailbox.deposit(frame(dmEvent(1)));
    expect(mailbox.statuses).toEqual([200]);
    expect(delivered).toHaveLength(0);

    listening = true;
    await mailbox.deposit(frame(dmEvent(2)));
    expect(delivered.map((m) => m.text)).toEqual(["message 2"]);
  });

  it("hands a message Slack delivers again to Chats, which has it once", async () => {
    const mailbox = fakeMailbox();
    const chats = fakeChats();
    const first = adapter(mailbox, fakeApi(), { chats });
    await first.adapter.start();
    await mailbox.deposit(frame(dmEvent(1)));
    await first.adapter.stop();

    const restarted = adapter(mailbox, fakeApi(), { chats });
    await restarted.adapter.start();
    await mailbox.deposit(frame(dmEvent(1)));
    expect(mailbox.statuses).toEqual([200, 200]);
    expect(chats.delivered.map((m) => m.text)).toEqual(["message 1"]);
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
    persist: (drainKey: string) => Promise<void> = async () => {},
  ) {
    const opened: string[] = [];
    const stopped: string[] = [];
    const faults: string[] = [];
    const refreshed: string[] = [];
    const open: OpenMailbox = (mailbox) => {
      opened.push(mailbox.drainKey);
      return { stop: () => void stopped.push(mailbox.drainKey), attempts: 4 };
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
      onMailboxRefreshed: async (mailbox) => {
        refreshed.push(mailbox.drainKey);
        await persist(mailbox.drainKey);
      },
      onFault: ({ kind }) => faults.push(kind),
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
          attempts: 4,
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
      });
      a.onInbound((message) => void order.push(`delivered ${message.content.text}`));
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

  it("drains with the stored key when the fresh one could not be kept, and renews it later", () =>
    withClock(async () => {
      const stored = keyExpiringAt(NOW + 30 * DAY, "stored");
      const fresh = keyExpiringAt(NOW + 120 * DAY, "fresh");
      let keeps = false;
      const t = renewing(
        stored,
        async () => ({ connectUrl: "wss://relay.test/c/mbx", drainKey: fresh }),
        async () => {
          if (!keeps) throw new Error("database is locked");
        },
      );
      await t.adapter.start();
      // The relay still takes the stored key, which a restart reads back.
      expect(t.opened).toEqual([stored]);
      keeps = true;
      await rs.advanceTimersByTimeAsync(23 * DAY + 1000);
      expect(t.opened).toEqual([stored, fresh]);
      expect(t.faults).toEqual([]);
      await t.adapter.stop();
    }));

  it("waits for the hourly retry when Rome Cloud answers a key already due for renewal", () =>
    withClock(async () => {
      const key = keyExpiringAt(NOW + 3 * DAY);
      let calls = 0;
      const t = renewing(key, async () => {
        calls++;
        return { connectUrl: "wss://relay.test/c/mbx", drainKey: key };
      });
      await t.adapter.start();
      await rs.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      await rs.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(calls).toBe(3);
      expect(t.opened).toEqual([key]);
      await t.adapter.stop();
    }));

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
  options: { gate?: SlackReadGate; listened?: () => boolean } = {},
) {
  const api = fakeApi({ conversationHistory: slack.conversationHistory });
  return adapter(mailbox, api, {
    readGate: options.gate ?? openGate(),
    ...(options.listened ? { listened: options.listened } : {}),
  });
}

const texts = (messages: ChannelMessage[]) => messages.map((m) => m.text);

describe("Slack app reads a direct message (R13)", () => {
  it("reads from Slack on every read, since the connection keeps no copy of the chat", async () => {
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
    expect(slack.calls).toHaveLength(2);
  });

  it("pages back from the oldest message a read answered", async () => {
    const slack = fakeSlackHistory();
    for (let i = 1; i <= 12; i++) slack.say(i, i % 3 === 0 ? "bot" : "member");
    const mailbox = fakeMailbox();
    const { adapter: a } = historyAdapter(mailbox, slack);
    await a.start();
    const older = await a.readHistory("D_GUARDIAN" as never, {
      olderThan: "1700000000.000007",
      limit: 3,
    });
    expect(texts(older)).toEqual(["message 6", "message 5", "message 4"]);
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
        { readGate: openGate() },
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

  it("reads forward when one page reaches the read's time bound", async () => {
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

  it("reads below its own upper bound when a newer message was heard", async () => {
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
    const { adapter: a } = adapter(mailbox, api, { readGate: openGate() });
    await a.start();
    await expect(a.readHistory("D_GONE" as never, { limit: 5 })).rejects.toThrow(
      /may not read chat D_GONE \(missing_scope\)/,
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

describe("Slack app reads Slack refused as too soon", () => {
  it("waits out Slack's Retry-After and asks again, and starts the next turn from Slack's answer", async () => {
    const asked: number[] = [];
    let refuse = true;
    const fetchImpl = (async () => {
      asked.push(Date.now());
      if (refuse) {
        refuse = false;
        return new Response(null, { status: 429, headers: { "retry-after": "1" } });
      }
      return Response.json({ ok: true, messages: [{ ts: "1.0", text: "root", user: "U1" }] });
    }) as unknown as typeof fetch;
    const api = createSlackAppWebApi("http://fake-slack.test", fetchImpl);
    const gate = new SlackReadGate({ intervalMs: 300, maxWaitMs: 60_000 });
    const replies = (ts: string) =>
      gate.run(`replies:C1:${ts}`, () =>
        api.conversationReplies("t", { channel: "C1", ts, limit: 15 }),
      );

    const [first, second] = await Promise.all([replies("1.0"), replies("2.0")]);
    expect(first.messages.map((m) => m.text)).toEqual(["root"]);
    expect(second.messages).toHaveLength(1);
    expect(asked).toHaveLength(3);
    // Retry-After held the first read a second before it asked again.
    expect(asked[1] - asked[0]).toBeGreaterThanOrEqual(1_000 - TIMER_SLACK_MS);
    // The second thread's turn began when Slack answered, not when the
    // first read started.
    expect(asked[2] - asked[1]).toBeGreaterThanOrEqual(300 - TIMER_SLACK_MS);
  });

  it("answers a read that waited its full turn behind one still in flight", async () => {
    const asked: number[] = [];
    const gate = new SlackReadGate({ intervalMs: 300, maxWaitMs: 300 });
    const slow = () =>
      new Promise<string>((resolve) => {
        asked.push(Date.now());
        setTimeout(() => resolve("page"), 100);
      });

    const first = gate.run("a", slow);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = gate.run("b", slow);

    await expect(Promise.all([first, second])).resolves.toEqual(["page", "page"]);
    // The second asked a full turn after Slack answered the first.
    expect(asked[1] - asked[0]).toBeGreaterThanOrEqual(400 - TIMER_SLACK_MS);
  });

  it("refuses a read whose Retry-After would take it past its limit, without asking Slack again", async () => {
    const asked: number[] = [];
    const fetchImpl = (async () => {
      asked.push(Date.now());
      return new Response(null, { status: 429, headers: { "retry-after": "20" } });
    }) as unknown as typeof fetch;
    const api = createSlackAppWebApi("http://fake-slack.test", fetchImpl);
    const gate = new SlackReadGate({ intervalMs: 300, maxWaitMs: 500 });

    await expect(
      gate.run("replies:C1:1.0", () =>
        api.conversationReplies("t", { channel: "C1", ts: "1.0", limit: 15 }),
      ),
    ).rejects.toThrow(/Try again in 20 seconds/);
    expect(asked).toHaveLength(1);
  });
});

describe("Slack app in the channels it is a member of", () => {
  const NEWS = { id: "C_NEWS", name: "news", isPrivate: false };
  const OPS = { id: "G_OPS", name: "ops", isPrivate: true };

  function channelApi(overrides: Partial<SlackAppWebApi> = {}) {
    const history = fakeSlackHistory();
    return fakeApi({
      memberChannels: rs.fn(async () => ({ channels: [OPS, NEWS] })),
      conversationHistory: history.conversationHistory,
      ...overrides,
    });
  }

  it("sends to a channel by the name people use for it", async () => {
    const api = channelApi();
    const { adapter: a } = adapter(fakeMailbox(), api, { readGate: openGate() });
    await a.start();

    const receipt = await a.send("#news" as never, { text: "hello" });
    await a.send("#News:1700000000.000001" as never, { text: "in thread" });

    expect(api.postMessage).toHaveBeenNthCalledWith(
      1,
      "xoxb-a",
      { channel: "C_NEWS", markdown: "hello", threadTs: undefined },
      expect.anything(),
    );
    expect(api.postMessage).toHaveBeenNthCalledWith(
      2,
      "xoxb-a",
      { channel: "C_NEWS", markdown: "in thread", threadTs: "1700000000.000001" },
      expect.anything(),
    );
    expect(receipt.chatId).toBe("C_NEWS");
    // Each send by name reads the listing again.
    expect(api.memberChannels).toHaveBeenCalledTimes(2);
  });

  it("sends by a name to the channel that holds it now, after a rename gave it to another", async () => {
    let channels = [OPS, NEWS];
    const api = channelApi({ memberChannels: rs.fn(async () => ({ channels })) });
    const { adapter: a } = adapter(fakeMailbox(), api, { readGate: openGate() });
    await a.start();
    await a.send("#news" as never, { text: "first" });

    // #news is renamed #general, and #ops takes the name #news.
    channels = [
      { ...NEWS, name: "general" },
      { ...OPS, name: "news" },
    ];
    await a.send("#news" as never, { text: "second" });

    expect(api.postMessage).toHaveBeenNthCalledWith(
      2,
      "xoxb-a",
      { channel: "G_OPS", markdown: "second", threadTs: undefined },
      expect.anything(),
    );
  });

  it("refuses a name no channel it is a member of has, saying so", async () => {
    const api = channelApi();
    const { adapter: a } = adapter(fakeMailbox(), api, { readGate: openGate() });
    await a.start();

    await expect(a.send("#random" as never, { text: "hi" })).rejects.toThrow(
      "Rome's Slack app is not a member of a channel named #random",
    );
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it("reads a channel it is a member of from Slack, newest first, by name or id", async () => {
    const said: SlackWireMessage[] = [1, 2, 3].map((i) => ({
      ts: `1700000000.00000${i}`,
      user: "U_MEMBER",
      text: `news ${i}`,
    }));
    const api = channelApi({
      conversationHistory: rs.fn(async () => ({ messages: [...said].reverse(), hasMore: false })),
    });
    const { adapter: a } = adapter(fakeMailbox(), api, { readGate: openGate() });
    await a.start();

    const byName = await a.readHistory("#news" as never, { limit: 10 });

    expect(texts(byName)).toEqual(["news 3", "news 2", "news 1"]);
    expect(byName[0]).toMatchObject({ chatId: "C_NEWS", thread: { kind: "group" } });
    expect(api.conversationHistory).toHaveBeenCalledWith(
      "xoxb-a",
      expect.objectContaining({ channel: "C_NEWS" }),
      expect.anything(),
    );
  });

  it("reads a thread from Slack's replies, its root included, newest first", async () => {
    const api = channelApi({
      conversationReplies: rs.fn(async () => ({
        messages: [
          {
            ts: "1700000000.000001",
            user: "U_MEMBER",
            text: "root",
            thread_ts: "1700000000.000001",
          },
          {
            ts: "1700000000.000002",
            user: "U_GUARDIAN",
            text: "reply",
            thread_ts: "1700000000.000001",
          },
          { ts: "1700000000.000003", user: BOT, text: "rome says", thread_ts: "1700000000.000001" },
        ],
      })),
    });
    const { adapter: a } = adapter(fakeMailbox(), api, { readGate: openGate() });
    await a.start();

    const thread = await a.readHistory("C_NEWS:1700000000.000001" as never, { limit: 10 });
    const older = await a.readHistory("C_NEWS:1700000000.000001" as never, {
      olderThan: "1700000000.000001:1700000000.000003",
      limit: 10,
    });

    expect(texts(thread)).toEqual(["rome says", "reply", "root"]);
    expect(thread[0]).toMatchObject({ direction: "outbound" });
    expect(thread[1]?.messageId).toBe("1700000000.000001:1700000000.000002");
    expect(texts(older)).toEqual(["reply", "root"]);
  });

  it("reads a thread longer than Slack's page of 15 on from newerThan, each page asking Slack from there", async () => {
    const root = "1700000000.000100";
    // 20 replies after the root: Slack answers 15 a page, oldest first, from
    // `oldest` when it names one.
    const all = Array.from({ length: 21 }, (_, i) => ({
      ts: `1700000000.${String(100 + i).padStart(6, "0")}`,
      user: "U_MEMBER",
      text: `message ${i}`,
      thread_ts: root,
    }));
    const conversationReplies = rs.fn(
      async (_token: string, input: { oldest?: string; limit: number }) => {
        const after = all.filter((wire) => !input.oldest || wire.ts > input.oldest);
        // Slack always answers the root first.
        const page = [all[0], ...after.filter((wire) => wire.ts !== root)].slice(0, input.limit);
        return {
          messages: page as typeof all,
          ...(after.length > input.limit ? { nextCursor: "more" } : {}),
        };
      },
    );
    const api = channelApi({ conversationReplies });
    const { adapter: a } = adapter(fakeMailbox(), api, { readGate: openGate() });
    await a.start();

    const first = await a.readHistory(`C_NEWS:${root}` as never, { limit: 100 });
    const newest = first[0]?.messageId as string;
    const second = await a.readHistory(`C_NEWS:${root}` as never, {
      newerThan: newest,
      limit: 100,
    });
    const last = await a.readHistory(`C_NEWS:${root}` as never, {
      newerThan: second[0]?.messageId as string,
      limit: 100,
    });
    const fromStart = await a.readHistory(`C_NEWS:${root}` as never, { limit: 3 });
    // A read on from a message, bounded above too, still answers the messages
    // just after it, so reading on from its newest skips none.
    const onUntil = await a.readHistory(`C_NEWS:${root}` as never, {
      newerThan: root,
      until: new Date(1_800_000_000_000),
      limit: 3,
    });

    expect(texts(first)).toHaveLength(15);
    expect(texts(first).at(-1)).toBe("message 0");
    expect(texts(second)).toEqual(
      [
        "message 15",
        "message 16",
        "message 17",
        "message 18",
        "message 19",
        "message 20",
      ].reverse(),
    );
    expect(last).toEqual([]);
    expect(conversationReplies).toHaveBeenNthCalledWith(
      2,
      "xoxb-a",
      expect.objectContaining({ oldest: "1700000000.000114" }),
      expect.anything(),
    );
    // With no bound, a thread is read from its start, as Slack reads it.
    expect(texts(fromStart)).toEqual(["message 2", "message 1", "message 0"]);
    expect(texts(onUntil)).toEqual(["message 3", "message 2", "message 1"]);
  });

  it("says where to read on when a page of a thread held nothing Rome reads, rather than end the thread", async () => {
    const root = "1700000000.000100";
    const files = Array.from({ length: 15 }, (_, i) => ({
      ts: `1700000000.${String(101 + i).padStart(6, "0")}`,
      user: "U_MEMBER",
      text: "",
      subtype: "file_share",
      thread_ts: root,
    }));
    const api = channelApi({
      conversationReplies: rs.fn(async () => ({ messages: files, nextCursor: "more" })),
    });
    const { adapter: a } = adapter(fakeMailbox(), api, { readGate: openGate() });
    await a.start();

    await expect(
      a.readHistory(`C_NEWS:${root}` as never, { newerThan: root, limit: 100 }),
    ).rejects.toThrow("Read on with newerThan=1700000000.000115");
  });

  it("reads a thread in the same minute as a page of history, since Slack paces each method on its own", async () => {
    const root = "1700000000.000005";
    const api = channelApi({
      conversationHistory: rs.fn(async () => ({
        messages: [{ ts: "1700000000.000004", user: "U_MEMBER", text: "in the channel" }],
        hasMore: false,
      })),
      conversationReplies: rs.fn(async () => ({
        messages: [{ ts: root, user: "U_MEMBER", text: "root", thread_ts: root }],
      })),
    });
    const pace = () => new SlackReadGate({ intervalMs: 60_000, maxWaitMs: 0 });
    const a = new SlackAppAdapter({
      channel: "slack_app",
      botToken: "xoxb-a",
      teamId: TEAM,
      botUserId: BOT,
      forwardSecret: SECRET,
      mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: "k" },
      api,
      openMailbox: fakeMailbox().open,
      readGate: pace(),
      repliesGate: pace(),
    });
    await a.start();

    const history = await a.readHistory("C_NEWS" as never, { limit: 10 });
    const thread = await a.readHistory(`C_NEWS:${root}` as never, { limit: 10 });

    expect(texts(history)).toEqual(["in the channel"]);
    expect(texts(thread)).toEqual(["root"]);
  });

  it("reads a thread and a page of history ending at its root as two calls to Slack", async () => {
    const root = "1700000000.000005";
    const api = channelApi({
      conversationHistory: rs.fn(async () => ({
        messages: [{ ts: "1700000000.000004", user: "U_MEMBER", text: "before the root" }],
        hasMore: false,
      })),
      conversationReplies: rs.fn(async () => ({
        messages: [{ ts: root, user: "U_MEMBER", text: "root", thread_ts: root }],
      })),
    });
    const { adapter: a } = adapter(fakeMailbox(), api, { readGate: openGate() });
    await a.start();

    const [thread, history] = await Promise.all([
      a.readHistory(`C_NEWS:${root}` as never, { limit: 10 }),
      a.readHistory("C_NEWS" as never, { olderThan: root, limit: 10 }),
    ]);

    expect(texts(thread)).toEqual(["root"]);
    expect(texts(history)).toEqual(["before the root"]);
    expect(api.conversationReplies).toHaveBeenCalledTimes(1);
    expect(api.conversationHistory).toHaveBeenCalledTimes(1);
  });

  it("keeps direct messages and mentions working in a workspace connected with the old scopes, and asks for approval for the rest", async () => {
    const missing = async () => {
      throw new SlackApiError("missing_scope");
    };
    const api = channelApi({ memberChannels: rs.fn(missing), conversationHistory: rs.fn(missing) });
    const { adapter: a, delivered } = adapter(fakeMailbox(), api, { readGate: openGate() });
    await a.start();

    await a.handleFrame(frame(dmEvent(1)));
    await a.handleFrame(frame(mentionEvent(2)));
    await a.send("D_GUARDIAN" as never, { text: "still here" });

    expect(texts(delivered)).toEqual(["message 1", "question 2"]);
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    await expect(a.send("#news" as never, { text: "hi" })).rejects.toThrow(
      "approve the app again from Slack in Settings › Connections",
    );
    await expect(a.readHistory("C_NEWS" as never, { limit: 5 })).rejects.toThrow(
      "approve the app again from Slack in Settings › Connections",
    );
    await expect(a.channels()).rejects.toThrow("approve the app again");
  });

  it("refuses a read of a channel it is not a member of, saying how to add it", async () => {
    const api = channelApi({
      conversationHistory: rs.fn(async () => {
        throw new SlackApiError("not_in_channel");
      }),
    });
    const { adapter: a } = adapter(fakeMailbox(), api, { readGate: openGate() });
    await a.start();

    await expect(a.readHistory("C_ELSE" as never, { limit: 5 })).rejects.toThrow(
      "Rome's Slack app is not a member of chat C_ELSE",
    );
  });
});
