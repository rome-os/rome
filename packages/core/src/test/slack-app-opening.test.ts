// What a new session in a Slack app chat reads from before it: the chat's
// latest messages, read through the connection, whether or not the
// connection's own copy still holds them. Built in test/ because it crosses
// the connection and the prompt facts. Rome keeps no record of the chat here
// at all, and the connection's copy is first full, then wiped and the
// connection restarted, and the session reads the same both times.

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ThreadContext } from "@rome-os/app-runtime";
import { SenderLabels } from "../chats/sender-labels.js";
import { SlackMessageCopyRepository } from "../connections/kinds/slack-app/message-copy.js";
import type { SlackWireMessage } from "../connections/kinds/slack-app/message.js";
import { SlackReadGate } from "../connections/kinds/slack-app/read-gate.js";
import { type MailboxFrame, SlackAppAdapter } from "../connections/kinds/slack-app/slack-app.js";
import {
  FORWARD_SIGNATURE_HEADER,
  FORWARD_TEAM_HEADER,
  FORWARD_TIMESTAMP_HEADER,
  forwardSignature,
} from "../connections/kinds/slack-app/forward.js";
import { chatPromptFacts } from "../core/chat-prompt-facts.js";
import { slackAppMessages, slackAppTimeline } from "../db/schema/system.js";
import { createTestDb, type TestDb } from "./db.js";

const TEAM = "T_A";
const BOT = "U_BOT";
const SECRET = "forward-secret-a";
const MEMBER = "U_GUARDIAN";
const CHAT = "D_GUARDIAN";

const tsOf = (i: number) => `1700000000.${String(i).padStart(6, "0")}`;

/** Slack's side of the direct message: every message said there, answered as
 *  conversations.history pages are, newest first. */
function slackSide() {
  const said: SlackWireMessage[] = [];
  const conversationHistory = rs.fn(
    async (_token: string, input: { channel: string; latest?: string; limit: number }) => {
      const older = said
        .filter((m) => input.latest === undefined || Number(m.ts) < Number(input.latest))
        .sort((a, b) => Number(b.ts) - Number(a.ts));
      return { messages: older.slice(0, input.limit), hasMore: older.length > input.limit };
    },
  );
  return { said, conversationHistory };
}

/** Message `i` as Rome Cloud deposits its event, signed: the member's when
 *  `i` is odd, else the app's own post, which Slack also sends an event for. */
function heard(i: number, ts = tsOf(i)): MailboxFrame {
  const body = new TextEncoder().encode(
    JSON.stringify({
      type: "event_callback",
      team_id: TEAM,
      api_app_id: "A_ROME",
      event_id: `Ev${i}`,
      event: {
        type: "message",
        channel_type: "im",
        channel: CHAT,
        user: i % 2 === 0 ? BOT : MEMBER,
        ...(i % 2 === 0 ? { bot_id: "B_ROME" } : {}),
        text: `message ${i}`,
        ts,
      },
    }),
  );
  const timestamp = "1700000000";
  return {
    headers: {
      [FORWARD_TEAM_HEADER]: TEAM,
      [FORWARD_TIMESTAMP_HEADER]: timestamp,
      [FORWARD_SIGNATURE_HEADER]: forwardSignature({
        forwardSecret: SECRET,
        timestamp,
        teamId: TEAM,
        body,
      }),
    },
    body,
  };
}

describe("a new session in a Slack app chat (R13, option b)", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  it("reads the chat's latest messages the same with the connection's copy full and wiped", async () => {
    const slack = slackSide();
    for (let i = 1; i <= 6; i++) {
      slack.said.push({
        ts: tsOf(i),
        user: i % 2 === 0 ? BOT : MEMBER,
        ...(i % 2 === 0 ? { bot_id: "B_ROME" } : {}),
        text: `message ${i}`,
      });
    }
    // A backlog said after the turn the session opens on, more than a page
    // holds: it takes no room on the page of earlier messages.
    const backlogTs = (i: number) => `1700000100.${String(i).padStart(6, "0")}`;
    for (let i = 7; i <= 23; i++) {
      slack.said.push({ ts: backlogTs(i), user: MEMBER, text: `message ${i}` });
    }

    let onFrame: ((frame: MailboxFrame) => Promise<{ status: number }>) | null = null;
    const connect = () => {
      const adapter = new SlackAppAdapter({
        channel: "slack_app",
        botToken: "xoxb-a",
        teamId: TEAM,
        botUserId: BOT,
        forwardSecret: SECRET,
        mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: "k" },
        api: {
          authTest: async () => ({ teamId: TEAM, botUserId: BOT, appId: "A_ROME" }),
          postMessage: async () => ({ ts: "9.0" }),
          openDirectMessage: async () => "D_NEW",
          userName: async () => ({ displayName: "Ouou", username: "ouou" }),
          conversationHistory: slack.conversationHistory,
          conversationReplies: async () => ({ messages: [] }),
          memberChannels: async () => ({ channels: [] }),
          revoke: async () => {},
        },
        openMailbox: (_mailbox, handler) => {
          onFrame = handler;
          return { stop: () => {} };
        },
        copy: new SlackMessageCopyRepository(testDb.db),
        readGate: new SlackReadGate({ intervalMs: 0, maxWaitMs: 0 }),
      });
      adapter.onInbound(() => {});
      return adapter;
    };
    // The session's prompt facts, reading the chat through `adapter` as the
    // channels service reads it, with no record of Rome's own behind them.
    const factsOver = (adapter: SlackAppAdapter) =>
      chatPromptFacts({
        facts: { unseen: () => [], seen: () => {} },
        messages: { byIds: () => [] },
        labels: new SenderLabels({ byAccount: async () => null }),
        channelOfChat: () => "slack_app",
        channelSurface: () => ({ interactiveCards: false, promptContext: true }),
        latest: (place, read) => adapter.readHistory(place.threadId as never, read),
      });
    const place: ThreadContext = { channel: "slack_app", threadId: CHAT, threadType: "private" };
    const before = new Date("2023-11-14T22:14:00.000Z");

    // The copy full: the connection heard every message of the chat.
    const first = connect();
    await first.start();
    for (let i = 1; i <= 6; i++) await onFrame!(heard(i));
    for (let i = 7; i <= 23; i++) await onFrame!(heard(i, backlogTs(i)));
    expect(testDb.db.select().from(slackAppMessages).all()).not.toHaveLength(0);
    const readsBeforeFull = slack.conversationHistory.mock.calls.length;
    const full = await factsOver(first).earlier!(place, before);
    const readsAfterFull = slack.conversationHistory.mock.calls.length;
    await first.stop();

    // The copy wiped, and the connection restarted on it.
    testDb.db.delete(slackAppMessages).run();
    testDb.db.delete(slackAppTimeline).run();
    const second = connect();
    await second.start();
    const readsBeforeWiped = slack.conversationHistory.mock.calls.length;
    const wiped = await factsOver(second).earlier!(place, before);
    await second.stop();

    expect(full?.map((m) => [m.text, m.fromRome])).toEqual([
      ["message 1", false],
      ["message 2", true],
      ["message 3", false],
      ["message 4", true],
      ["message 5", false],
      ["message 6", true],
    ]);
    expect(wiped).toEqual(full);
    // Each asked Slack once, from the turn's time: a drain's first messages
    // never say which is the chat's newest, since Slack may be retrying old
    // ones, so the copy answers only once a read has asked Slack.
    const latestOf = (calls: typeof slack.conversationHistory.mock.calls) =>
      calls.map(([, input]) => input.latest);
    const calls = slack.conversationHistory.mock.calls;
    expect(latestOf(calls.slice(readsBeforeFull, readsAfterFull))).toEqual(["1700000040.000001"]);
    expect(latestOf(calls.slice(readsBeforeWiped))).toEqual(["1700000040.000001"]);
  });

  it("reads what came before the session's first message when more than a page followed it in the same second", async () => {
    const slack = slackSide();
    // Three messages, the session's first at .000500 of the same second, then
    // twenty more in that second: more than Slack's page of 15.
    const inSecond = (micros: number) => `1700000040.${String(micros).padStart(6, "0")}`;
    for (const [micros, text] of [
      [100, "it is 42"],
      [300, "or 43"],
      [500, "what is it?"],
    ] as const) {
      slack.said.push({ ts: inSecond(micros), user: MEMBER, text });
    }
    for (let i = 0; i < 20; i++) {
      slack.said.push({ ts: inSecond(600 + i), user: MEMBER, text: `later ${i}` });
    }
    const adapter = new SlackAppAdapter({
      channel: "slack_app",
      botToken: "xoxb-a",
      teamId: TEAM,
      botUserId: BOT,
      forwardSecret: SECRET,
      mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: "k" },
      api: {
        authTest: async () => ({ teamId: TEAM, botUserId: BOT, appId: "A_ROME" }),
        postMessage: async () => ({ ts: "9.0" }),
        openDirectMessage: async () => "D_NEW",
        userName: async () => ({ displayName: "Ouou", username: "ouou" }),
        conversationHistory: slack.conversationHistory,
        conversationReplies: async () => ({ messages: [] }),
        memberChannels: async () => ({ channels: [] }),
        revoke: async () => {},
      },
      openMailbox: () => ({ stop: () => {} }),
      copy: new SlackMessageCopyRepository(testDb.db),
      readGate: new SlackReadGate({ intervalMs: 0, maxWaitMs: 0 }),
    });
    adapter.onInbound(() => {});
    await adapter.start();
    const facts = chatPromptFacts({
      facts: { unseen: () => [], seen: () => {} },
      // Rome's record of the session's first message, by its Slack ts.
      messages: { byIds: () => [{ key: inSecond(500) } as never] },
      labels: new SenderLabels({ byAccount: async () => null }),
      channelOfChat: () => "slack_app",
      channelSurface: () => ({ interactiveCards: false, promptContext: true }),
      latest: (place, read) => adapter.readHistory(place.threadId as never, read),
    });
    const place: ThreadContext = { channel: "slack_app", threadId: CHAT, threadType: "private" };

    // Rome's record holds the first message at the whole second.
    const earlier = await facts.earlier!(place, new Date(1_700_000_040_000), 1);
    await adapter.stop();

    expect(earlier?.map((m) => m.text)).toEqual(["it is 42", "or 43"]);
  });
});

describe("a mention inside a Slack thread (R14)", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  it("reaches the agent with the thread's earlier messages, read from Slack's replies", async () => {
    const root = tsOf(1);
    const thread: SlackWireMessage[] = [
      { ts: root, user: "U_SAM", text: "Picnic on Saturday?", thread_ts: root },
      { ts: tsOf(2), user: "U_KIM", text: "It moved to Hollyfold Meadow", thread_ts: root },
      { ts: tsOf(3), user: MEMBER, text: `<@${BOT}> where is it?`, thread_ts: root },
      { ts: tsOf(4), user: "U_SAM", text: "said after the mention", thread_ts: root },
    ];
    const conversationReplies = rs.fn(async () => ({ messages: thread }));
    const delivered: ChannelMessage[] = [];
    let onFrame: ((frame: MailboxFrame) => Promise<{ status: number }>) | null = null;
    const adapter = new SlackAppAdapter({
      channel: "slack_app",
      botToken: "xoxb-a",
      teamId: TEAM,
      botUserId: BOT,
      forwardSecret: SECRET,
      mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: "k" },
      api: {
        authTest: async () => ({ teamId: TEAM, botUserId: BOT, appId: "A_ROME" }),
        postMessage: async () => ({ ts: "9.0" }),
        openDirectMessage: async () => "D_NEW",
        userName: async () => ({}),
        conversationHistory: async () => ({ messages: [], hasMore: false }),
        conversationReplies,
        memberChannels: async () => ({ channels: [] }),
        revoke: async () => {},
      },
      openMailbox: (_mailbox, handler) => {
        onFrame = handler;
        return { stop: () => {} };
      },
      copy: new SlackMessageCopyRepository(testDb.db),
      readGate: new SlackReadGate({ intervalMs: 0, maxWaitMs: 0 }),
    });
    adapter.onInbound((message) => delivered.push(message));
    await adapter.start();

    await onFrame!(
      signed({
        type: "event_callback",
        team_id: TEAM,
        api_app_id: "A_ROME",
        event_id: "EvT3",
        event: { type: "app_mention", channel: "C_NEWS", ...thread[2] },
      }),
    );
    const mention = delivered[0];
    const facts = chatPromptFacts({
      facts: { unseen: () => [], seen: () => {} },
      messages: { byIds: () => [{ key: mention.messageId }] as never },
      labels: new SenderLabels({ byAccount: async () => null }),
      channelOfChat: () => "slack_app",
      channelSurface: () => ({ interactiveCards: false, promptContext: true }),
      latest: (place, read) => adapter.readHistory(place.threadId as never, read),
    });
    const place: ThreadContext = { channel: "slack_app", threadId: "C_NEWS", threadType: "group" };
    const earlier = await facts.thread!(place, mention.inThread!, mention.timestamp, 1);
    await adapter.stop();

    expect(mention.inThread).toBe(`C_NEWS:${root}`);
    expect(earlier?.map((m) => m.text)).toEqual([
      "Picnic on Saturday?",
      "It moved to Hollyfold Meadow",
    ]);
    expect(conversationReplies).toHaveBeenCalledTimes(1);
  });

  it("names no thread on a mention that is not in one", async () => {
    const delivered: ChannelMessage[] = [];
    let onFrame: ((frame: MailboxFrame) => Promise<{ status: number }>) | null = null;
    const adapter = new SlackAppAdapter({
      channel: "slack_app",
      botToken: "xoxb-a",
      teamId: TEAM,
      botUserId: BOT,
      forwardSecret: SECRET,
      mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: "k" },
      api: {
        authTest: async () => ({ teamId: TEAM, botUserId: BOT, appId: "A_ROME" }),
        postMessage: async () => ({ ts: "9.0" }),
        openDirectMessage: async () => "D_NEW",
        userName: async () => ({}),
        conversationHistory: async () => ({ messages: [], hasMore: false }),
        conversationReplies: async () => ({ messages: [] }),
        memberChannels: async () => ({ channels: [] }),
        revoke: async () => {},
      },
      openMailbox: (_mailbox, handler) => {
        onFrame = handler;
        return { stop: () => {} };
      },
      copy: new SlackMessageCopyRepository(testDb.db),
      readGate: new SlackReadGate({ intervalMs: 0, maxWaitMs: 0 }),
    });
    adapter.onInbound((message) => delivered.push(message));
    await adapter.start();

    // A thread's root is said in the conversation, not in its thread.
    for (const [i, extra] of [
      [5, {}],
      [6, { thread_ts: tsOf(6) }],
    ] as const) {
      await onFrame!(
        signed({
          type: "event_callback",
          team_id: TEAM,
          api_app_id: "A_ROME",
          event_id: `EvR${i}`,
          event: {
            type: "app_mention",
            channel: "C_NEWS",
            user: MEMBER,
            text: `<@${BOT}> hello ${i}`,
            ts: tsOf(i),
            ...extra,
          },
        }),
      );
    }
    await adapter.stop();

    expect(delivered.map((m) => m.inThread)).toEqual([undefined, undefined]);
  });
});

/** `payload` as Rome Cloud deposits it, signed. */
function signed(payload: unknown): MailboxFrame {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const timestamp = "1700000000";
  return {
    headers: {
      [FORWARD_TEAM_HEADER]: TEAM,
      [FORWARD_TIMESTAMP_HEADER]: timestamp,
      [FORWARD_SIGNATURE_HEADER]: forwardSignature({
        forwardSecret: SECRET,
        timestamp,
        teamId: TEAM,
        body,
      }),
    },
    body,
  };
}
