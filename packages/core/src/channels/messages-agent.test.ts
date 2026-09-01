import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { DrizzleDb } from "../db/index.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { romeAgentMessages, romeSessions } from "../db/schema.js";
import { countingDb, createTestDb } from "../test/helpers.js";
import {
  testMessagesContract,
  WHOLE_HISTORY,
  type MessagesContractSubject,
} from "./messages-contract.js";
import { agentMessages } from "./messages-agent.js";
import type { MessageConversation } from "./messages.js";

// `rome_agent_messages` read as a `Messages` store, holding exactly what
// `agentMessagesSource` holds today: the roles that carry conversation, on
// channel sessions the account itself addresses.

const CHANNEL = "telegram";
/** The two addresses of the one account the fixtures speak to. */
const DIRECT = "tg-777";
const DIRECT_ALT = "tg-777-alt";
const GROUP = "tg-group-1";
const OTHER_CHANNEL = "discord";

const account = { channel: CHANNEL, addresses: [DIRECT, DIRECT_ALT] };
const silent = [{ channel: CHANNEL, addresses: ["tg-nobody"] }];
const groupThread: MessageConversation = { channel: CHANNEL, id: GROUP };
const emptyThread: MessageConversation = { channel: CHANNEL, id: "tg-no-session" };

const text = (line: string) => JSON.stringify([{ type: "text", content: line }]);

function session(
  db: DrizzleDb,
  id: string,
  fields: {
    type?: string;
    threadId: string | null;
    threadType?: string | null;
    channel?: string;
  },
) {
  const now = new Date(0);
  return db.insert(romeSessions).values({
    id,
    name: id,
    type: fields.type ?? "channel",
    sourceChannel: fields.channel ?? CHANNEL,
    sourceThreadId: fields.threadId,
    sourceThreadType: fields.threadType ?? "private",
    createdAt: now,
    activityAt: now,
  });
}

function message(
  db: DrizzleDb,
  id: string,
  fields: { sessionId: string; role: string; at: number; content?: string; senderId?: string },
) {
  return db.insert(romeAgentMessages).values({
    id,
    sessionId: fields.sessionId,
    role: fields.role,
    content: fields.content ?? text(id),
    senderId: fields.senderId ?? null,
    createdAt: new Date(fields.at * 1000),
  });
}

async function seed(db: DrizzleDb) {
  await session(db, "s-direct", { threadId: DIRECT });
  await session(db, "s-direct-alt", { threadId: DIRECT_ALT });
  await session(db, "s-group", { threadId: GROUP, threadType: "group" });
  await session(db, "s-webchat", { type: "webchat", threadId: null, threadType: null });
  // Another channel spelling a thread id exactly as Telegram spells this
  // account's. The store holds every channel side by side, so nothing but the
  // pair keeps the two conversations apart.
  await session(db, "s-elsewhere", { threadId: DIRECT, channel: OTHER_CHANNEL });

  // The same second twice, so the ordering and the cursor have a tie to settle.
  await message(db, "m-hello", { sessionId: "s-direct", role: "user", at: 100 });
  await message(db, "m-reply", { sessionId: "s-direct", role: "assistant", at: 100 });
  // A message that did not wake the agent is still something the person said.
  await message(db, "m-note", { sessionId: "s-direct", role: "notification", at: 200 });
  await message(db, "m-later", { sessionId: "s-direct", role: "user", at: 300 });
  // The account's other address: one history, not two halves of one.
  await message(db, "m-alt", { sessionId: "s-direct-alt", role: "user", at: 250 });

  // Out of every account's scope, each for its own reason.
  await message(db, "m-trace", { sessionId: "s-direct", role: "trace", at: 400 });
  // The group's own session, which only a conversation read reaches. Enough of
  // it to page, and a second in it said twice so the ordering has a tie.
  //
  // The first was sent by the account, and is still the group's: a line the
  // account wrote into a group belongs to the group's thread.
  await message(db, "m-group", {
    sessionId: "s-group",
    role: "user",
    at: 500,
    senderId: DIRECT,
  });
  await message(db, "m-group-reply", { sessionId: "s-group", role: "assistant", at: 500 });
  await message(db, "m-group-note", { sessionId: "s-group", role: "notification", at: 520 });
  await message(db, "m-group-later", { sessionId: "s-group", role: "user", at: 540 });
  await message(db, "m-webchat", { sessionId: "s-webchat", role: "user", at: 600 });
  await message(db, "m-elsewhere", { sessionId: "s-elsewhere", role: "user", at: 550 });
}

describe("agentMessages", () => {
  let db: DrizzleDb;
  let close: () => void;

  beforeEach(async () => {
    const test = createTestDb();
    db = test.db;
    close = test.close;
    await seed(db);
  });

  afterEach(() => close());

  const refs = async () =>
    (await agentMessages(db).read({ accounts: [account], limit: WHOLE_HISTORY })).map(
      (entry) => entry.ref,
    );

  it("answers the roles that carry conversation, newest first", async () => {
    expect(await refs()).toEqual([
      "agent:m-later",
      "agent:m-alt",
      "agent:m-note",
      "agent:m-reply",
      "agent:m-hello",
    ]);
  });

  it("leaves out a trace row, which belongs to no conversation", async () => {
    expect(await refs()).not.toContain("agent:m-trace");
  });

  it("leaves out a session a group addresses, whoever sent the message", async () => {
    expect(await refs()).not.toContain("agent:m-group");
    // And nothing reaches the group's own address either: it is not an account.
    const asGroup = await agentMessages(db).read({
      accounts: [{ channel: CHANNEL, addresses: [GROUP] }],
      limit: WHOLE_HISTORY,
    });
    expect(asGroup).toEqual([]);
  });

  // The session's thread is the conversation, and a group's session is the one
  // no account addresses.
  it("answers a group's session asked for as a conversation", async () => {
    const page = await agentMessages(db).readConversation({
      conversation: groupThread,
      limit: WHOLE_HISTORY,
    });
    expect(page.map((entry) => entry.ref)).toEqual([
      "agent:m-group-later",
      "agent:m-group-note",
      "agent:m-group-reply",
      "agent:m-group",
    ]);
  });

  it("keeps a conversation on its own channel", async () => {
    // `s-elsewhere` spells this account's thread id on another channel, so the
    // pair is all that keeps the two conversations apart.
    const here = await agentMessages(db).readConversation({
      conversation: { channel: CHANNEL, id: DIRECT },
      limit: WHOLE_HISTORY,
    });
    expect(here.map((entry) => entry.ref)).not.toContain("agent:m-elsewhere");
    const there = await agentMessages(db).readConversation({
      conversation: { channel: OTHER_CHANNEL, id: DIRECT },
      limit: WHOLE_HISTORY,
    });
    expect(there.map((entry) => entry.ref)).toEqual(["agent:m-elsewhere"]);
  });

  it("leaves a trace row out of a conversation too", async () => {
    const page = await agentMessages(db).readConversation({
      conversation: { channel: CHANNEL, id: DIRECT },
      limit: WHOLE_HISTORY,
    });
    expect(page.map((entry) => entry.ref)).not.toContain("agent:m-trace");
  });

  it("leaves out a session that is not a channel's", async () => {
    expect(await refs()).not.toContain("agent:m-webchat");
  });

  it("names the channel as the source and the direction by the role", async () => {
    const page = await agentMessages(db).read({ accounts: [account], limit: WHOLE_HISTORY });
    expect(page.every((entry) => entry.source === CHANNEL)).toBe(true);
    const byRef = new Map(page.map((entry) => [entry.ref, entry]));
    expect(byRef.get("agent:m-reply")?.direction).toBe("outbound");
    expect(byRef.get("agent:m-hello")?.direction).toBe("inbound");
    expect(byRef.get("agent:m-note")?.direction).toBe("inbound");
  });

  // The role cannot settle a notification's direction on its own: the writer
  // stores an undelivered *outbound* message under it too. Both sides of that
  // are written here through the repository that stores them, so the fixture
  // is the row the persistence layer really produces rather than one this test
  // believes it produces.
  describe("a notification, which the writer stores in both directions", () => {
    let repo: WebChatRepository;

    beforeEach(() => {
      repo = new WebChatRepository(db);
    });

    it("reads one Rome sent out of band as outbound", async () => {
      await repo.recordOutboundConversationMessage({
        sessionId: "s-direct",
        content: text("delivered without a turn"),
        platformMessageId: "pm-out-of-band",
        senderId: "rome",
        senderName: "Rome",
        knownToProvider: false,
      });
      expect(await agentMessages(db).latest([account])).toMatchObject({
        direction: "outbound",
        body: "delivered without a turn",
      });
    });

    // `sender_id` is a provider's own opaque string, so a channel is free to
    // hand out one that reads as Rome's marker. Only the role that cannot say
    // which way it went asks the sender, so the collision decides nothing
    // where the role already answers.
    it("leaves a role that already answers alone, whatever the sender is called", async () => {
      await repo.addConversationMessage({
        sessionId: "s-direct",
        role: "user",
        content: text("a provider that names its people 'rome'"),
        platformMessageId: "pm-collision",
        senderId: "rome",
        senderName: "Ada",
      });
      expect(await agentMessages(db).latest([account])).toMatchObject({
        direction: "inbound",
        body: "a provider that names its people 'rome'",
      });
    });

    it("reads one the person sent as inbound", async () => {
      await repo.addConversationMessage({
        sessionId: "s-direct",
        role: "notification",
        content: text("said while Rome slept"),
        platformMessageId: "pm-unwoken",
        senderId: DIRECT,
        senderName: "Ada",
      });
      expect(await agentMessages(db).latest([account])).toMatchObject({
        direction: "inbound",
        body: "said while Rome slept",
      });
    });
  });

  it("renders a message as its text parts, joined", async () => {
    await message(db, "m-parts", {
      sessionId: "s-direct",
      role: "user",
      at: 700,
      content: JSON.stringify([
        { type: "text", content: "first" },
        { type: "tool_use", name: "search" },
        { type: "text", content: "second" },
      ]),
    });
    expect(await agentMessages(db).latest([account])).toMatchObject({
      ref: "agent:m-parts",
      body: "first\nsecond",
    });
  });

  it("answers a row with nothing to show rather than failing the read", async () => {
    await message(db, "m-card", {
      sessionId: "s-direct",
      role: "assistant",
      at: 800,
      content: JSON.stringify([{ type: "card", payload: {} }]),
    });
    await message(db, "m-broken", { sessionId: "s-direct", role: "user", at: 900, content: "{" });
    const page = await agentMessages(db).read({ accounts: [account], limit: 2 });
    expect(page.map((entry) => [entry.ref, entry.body])).toEqual([
      ["agent:m-broken", null],
      ["agent:m-card", null],
    ]);
  });

  it("scopes an address to its own channel", async () => {
    expect(await refs()).not.toContain("agent:m-elsewhere");
    const elsewhere = await agentMessages(db).read({
      accounts: [{ channel: OTHER_CHANNEL, addresses: [DIRECT] }],
      limit: WHOLE_HISTORY,
    });
    expect(elsewhere.map((entry) => entry.ref)).toEqual(["agent:m-elsewhere"]);
  });

  // The scope is carried into the batch as pairs, so two calls that name one
  // address on two channels are answered from one pass without either taking
  // the other's rows. A store bound to a single channel cannot be asked this.
  it("keeps two channels apart inside one batch", async () => {
    const messages = agentMessages(db);
    const [here, there] = await Promise.all([
      messages.read({ accounts: [account], limit: WHOLE_HISTORY }),
      messages.read({
        accounts: [{ channel: OTHER_CHANNEL, addresses: [DIRECT] }],
        limit: WHOLE_HISTORY,
      }),
    ]);
    expect(here.map((entry) => entry.ref)).not.toContain("agent:m-elsewhere");
    expect(there.map((entry) => entry.ref)).toEqual(["agent:m-elsewhere"]);
  });

  it("costs one pass per round of calls, not one per account", async () => {
    const counted = countingDb(db);
    const messages = agentMessages(counted.db);
    const before = counted.passes();

    await Promise.all([
      messages.latest([account]),
      messages.latest([{ channel: OTHER_CHANNEL, addresses: [DIRECT] }]),
      messages.count([account]),
      messages.read({ accounts: [account], limit: 2 }),
    ]);

    expect(counted.passes() - before).toBe(1);
  });

  it("holds nothing for an empty scope", async () => {
    expect(await agentMessages(db).latest([])).toBeNull();
    expect(await agentMessages(db).count([])).toBe(0);
    expect(await agentMessages(db).read({ accounts: [], limit: WHOLE_HISTORY })).toEqual([]);
  });
});

// One seeded database for the whole suite: every assertion in it reads, so a
// fresh one per case would only buy migrations.
let enrolled: Promise<MessagesContractSubject> | null = null;

testMessagesContract("agentMessages", () => {
  enrolled ??= (async () => {
    const { db } = createTestDb();
    await seed(db);
    return {
      messages: agentMessages(db),
      accounts: [account],
      silent,
      conversation: groupThread,
      silentConversation: emptyThread,
    };
  })();
  return enrolled;
});
