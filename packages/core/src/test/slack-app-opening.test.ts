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
import { channelMessageOf } from "../chats/connected-accounts/channel-message.js";

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
    adapter.onInbound((message) => delivered.push(channelMessageOf(message, "slack_app")));
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
    // A thread of another chat is never read into this conversation's prompt.
    const elsewhere = await facts.thread!(place, `D_OTHER:${root}` as never, mention.timestamp, 1);
    await adapter.stop();

    expect(elsewhere).toBeNull();
    expect(mention.inThread).toBe(`C_NEWS:${root}`);
    expect(earlier?.messages.map((m) => m.text)).toEqual([
      "Picnic on Saturday?",
      "It moved to Hollyfold Meadow",
    ]);
    expect(conversationReplies).toHaveBeenCalledTimes(1);
  });

  it("reads a long thread again from the last mention the model was shown, not from its start", async () => {
    const root = tsOf(1);
    // A thread of 30 messages: Slack answers it oldest first, a page at a
    // time, from just after `oldest` when given.
    const thread: SlackWireMessage[] = Array.from({ length: 30 }, (_, i) => ({
      ts: tsOf(i + 1),
      user: i === 2 || i === 29 ? MEMBER : "U_SAM",
      text: i === 2 || i === 29 ? `<@${BOT}> mention ${i + 1}` : `reply ${i + 1}`,
      thread_ts: root,
    }));
    const conversationReplies = rs.fn(
      async (_token: string, input: { limit: number; oldest?: string }) => {
        const after = thread.filter((m) => !input.oldest || Number(m.ts) > Number(input.oldest));
        return {
          messages: after.slice(0, input.limit),
          ...(after.length > input.limit ? { nextCursor: "more" } : {}),
        };
      },
    );
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
        conversationReplies: conversationReplies as never,
        memberChannels: async () => ({ channels: [] }),
        revoke: async () => {},
      },
      openMailbox: () => ({ stop: () => {} }),
      copy: new SlackMessageCopyRepository(testDb.db),
      readGate: new SlackReadGate({ intervalMs: 0, maxWaitMs: 0 }),
    });
    await adapter.start();
    // Rome's record: id 3 is the first mention, id 30 the second, each kept
    // by its message id in the thread.
    const keys: Record<number, string> = { 3: `${root}:${tsOf(3)}`, 30: `${root}:${tsOf(30)}` };
    const facts = chatPromptFacts({
      facts: { unseen: () => [], seen: () => {} },
      messages: { byIds: (ids) => ids.map((id) => ({ key: keys[id] })) as never },
      labels: new SenderLabels({ byAccount: async () => null }),
      channelOfChat: () => "slack_app",
      channelSurface: () => ({ interactiveCards: false, promptContext: true }),
      latest: (place, read) => adapter.readHistory(place.threadId as never, read),
    });
    const place: ThreadContext = { channel: "slack_app", threadId: "C_NEWS", threadType: "group" };
    const at = (i: number) => new Date(Number(tsOf(i)) * 1_000);

    const first = await facts.thread!(place, `C_NEWS:${root}`, at(3), 3);
    const later = await facts.thread!(place, `C_NEWS:${root}`, at(30), 30, 3);
    // A session whose first message in the thread is the second mention.
    const late = await facts.thread!(place, `C_NEWS:${root}`, at(30), 30);
    await adapter.stop();

    expect(first?.messages.map((m) => m.text)).toEqual(["reply 1", "reply 2"]);
    expect(first?.cut).toBe(false);
    // What was said since the first mention, up to the second: a page from
    // the first mention on, none of what the model was shown before.
    expect(later?.messages.map((m) => m.text)).toEqual(
      Array.from({ length: 15 }, (_, i) => `reply ${i + 4}`),
    );
    // Replies 19 to 29 were not read: the model is told so.
    expect(later?.cut).toBe(true);
    // A first read of the thread that stops short of the mention says so too.
    expect(late?.messages.length).toBeGreaterThan(0);
    expect(late?.messages.map((m) => m.text)).not.toContain("reply 29");
    expect(late?.cut).toBe(true);
  });

  it("reads each thread of a group a mention is in, though Slack makes the second read wait its turn", async () => {
    // Two threads in #news, each with an earlier reply that holds a fact.
    const threads: Record<string, SlackWireMessage[]> = {
      [tsOf(100)]: [
        { ts: tsOf(100), user: "U_SAM", text: "Lunch plans?", thread_ts: tsOf(100) },
        { ts: tsOf(101), user: "U_SAM", text: "Noodle bar at noon", thread_ts: tsOf(100) },
      ],
      [tsOf(200)]: [
        { ts: tsOf(200), user: "U_SAM", text: "Offsite?", thread_ts: tsOf(200) },
        { ts: tsOf(201), user: "U_SAM", text: "It is in Lisbon", thread_ts: tsOf(200) },
      ],
    };
    const conversationReplies = rs.fn(async (_token: string, input: { ts: string }) => ({
      messages: threads[input.ts] ?? [],
    }));
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
        conversationReplies: conversationReplies as never,
        memberChannels: async () => ({ channels: [] }),
        revoke: async () => {},
      },
      openMailbox: () => ({ stop: () => {} }),
      copy: new SlackMessageCopyRepository(testDb.db),
      // Slack's pacing, scaled down: one thread read per 300 ms.
      repliesGate: new SlackReadGate({ intervalMs: 300, maxWaitMs: 300 }),
    });
    await adapter.start();
    const keys: Record<number, string> = {
      1: `${tsOf(100)}:${tsOf(102)}`,
      2: `${tsOf(200)}:${tsOf(202)}`,
    };
    const facts = chatPromptFacts({
      facts: { unseen: () => [], seen: () => {} },
      messages: { byIds: (ids) => ids.map((id) => ({ key: keys[id] })) as never },
      labels: new SenderLabels({ byAccount: async () => null }),
      channelOfChat: () => "slack_app",
      channelSurface: () => ({ interactiveCards: false, promptContext: true }),
      latest: (place, read) => adapter.readHistory(place.threadId as never, read),
      // A new session's read of the latest messages gives up much sooner
      // than a thread read waits for Slack.
      latestWaitMs: 50,
    });
    const place: ThreadContext = { channel: "slack_app", threadId: "C_NEWS", threadType: "group" };
    const at = new Date(Number(tsOf(300)) * 1_000);

    // One session: a mention in the first thread, then one in the second.
    const first = await facts.thread!(place, `C_NEWS:${tsOf(100)}`, at, 1);
    const second = await facts.thread!(place, `C_NEWS:${tsOf(200)}`, at, 2);
    await adapter.stop();

    expect(first?.messages.map((m) => m.text)).toContain("Noodle bar at noon");
    expect(second?.unread).toBeUndefined();
    expect(second?.messages.map((m) => m.text)).toContain("It is in Lisbon");
    expect(second?.messages.map((m) => m.text)).not.toContain("Noodle bar at noon");
    expect(conversationReplies).toHaveBeenCalledTimes(2);
  });

  it("names no thread on a mention that is not in one, nor on a reply in a direct message", async () => {
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
    adapter.onInbound((message) => delivered.push(channelMessageOf(message, "slack_app")));
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
    // In a direct message the app hears every reply in a thread, so none is
    // read again.
    await onFrame!(
      signed({
        type: "event_callback",
        team_id: TEAM,
        api_app_id: "A_ROME",
        event_id: "EvR7",
        event: {
          type: "message",
          channel: "D_MEMBER",
          channel_type: "im",
          user: MEMBER,
          text: "a reply in a thread of a direct message",
          ts: tsOf(7),
          thread_ts: tsOf(6),
        },
      }),
    );
    await adapter.stop();

    expect(delivered.map((m) => m.inThread)).toEqual([undefined, undefined, undefined]);
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
