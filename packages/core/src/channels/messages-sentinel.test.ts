import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { DrizzleDb } from "../db/index.js";
import { romeSessions, sentinelLog } from "../db/schema.js";
import { createTestDb } from "../test/helpers.js";
import {
  testAccountMessagesContract,
  WHOLE_HISTORY,
  type MessagesContractSubject,
} from "./messages-contract.js";
import { sentinelLogMessages } from "./messages-sentinel.js";

// `sentinel_log` read as an `AccountMessages` store, holding exactly what
// `sentinelLogSource` holds today: one row as the two lines it records, and
// the threads Rome knows to be groups subtracted.

const CHANNEL = "telegram";
const DIRECT = "tg-777";
const DIRECT_ALT = "tg-777-alt";
const GROUP = "tg-group-1";

const account = { channel: CHANNEL, addresses: [DIRECT, DIRECT_ALT] };
const silent = [{ channel: CHANNEL, addresses: ["tg-nobody"] }];

function row(
  db: DrizzleDb,
  id: string,
  fields: {
    at: number;
    text: string;
    response?: string | null;
    channelUserId?: string;
    channel?: string;
    threadId?: string | null;
  },
) {
  return db.insert(sentinelLog).values({
    id,
    messageId: `msg-${id}`,
    channel: fields.channel ?? CHANNEL,
    channelUserId: fields.channelUserId ?? DIRECT,
    threadId: fields.threadId ?? null,
    text: fields.text,
    action: fields.response ? "replied" : "ignored",
    response: fields.response ?? null,
    createdAt: new Date(fields.at * 1000),
  });
}

function groupSession(db: DrizzleDb, id: string, fields: { channel?: string; threadId: string }) {
  const now = new Date(0);
  return db.insert(romeSessions).values({
    id,
    name: id,
    type: "channel",
    sourceChannel: fields.channel ?? CHANNEL,
    sourceThreadId: fields.threadId,
    sourceThreadType: "group",
    createdAt: now,
    activityAt: now,
  });
}

async function seed(db: DrizzleDb) {
  await groupSession(db, "s-group", { threadId: GROUP });
  // The same thread id on another channel: a group there subtracts nothing here.
  await groupSession(db, "s-group-elsewhere", { channel: "discord", threadId: "tg-quiet-thread" });

  await row(db, "answered", { at: 1000, text: "ping", response: "pong", threadId: DIRECT });
  // The account's other address: one history, not two halves of one.
  await row(db, "alt", { at: 1050, text: "over here", channelUserId: DIRECT_ALT });
  // A thread no session covers is a direct exchange until something says so.
  await row(db, "unheard", { at: 1100, text: "solo", threadId: "tg-unknown-thread" });
  // An empty reply is no reply.
  await row(db, "quiet", { at: 1200, text: "hm", response: "", threadId: "tg-quiet-thread" });

  // Out of every account's scope: the thread a group session covers, and
  // another sender.
  await row(db, "in-group", { at: 900, text: "hi all", response: "hello", threadId: GROUP });
  await row(db, "in-group-2", { at: 950, text: "still here", response: "yep", threadId: GROUP });
  await row(db, "stranger", { at: 1300, text: "who?", channelUserId: "tg-stranger" });
}

describe("sentinelLogMessages", () => {
  let db: DrizzleDb;
  let close: () => void;

  beforeEach(async () => {
    const test = createTestDb();
    db = test.db;
    close = test.close;
    await seed(db);
  });

  afterEach(() => close());

  const page = () => sentinelLogMessages(db).read({ accounts: [account], limit: WHOLE_HISTORY });
  const refs = async () => (await page()).map((entry) => entry.ref);

  it("reads a row with a reply as two messages, inbound then outbound", async () => {
    const entries = await page();
    const inbound = entries.find((entry) => entry.ref === "sentinel:answered");
    const outbound = entries.find((entry) => entry.ref === "sentinel:answered:reply");
    expect(inbound).toMatchObject({ direction: "inbound", body: "ping", timestamp: 1000 });
    expect(outbound).toMatchObject({ direction: "outbound", body: "pong", timestamp: 1000 });
    // Rome's answer sits above the line it answers, on the one second they share.
    expect(entries.indexOf(outbound!)).toBeLessThan(entries.indexOf(inbound!));
  });

  it("names the sender and the thread the row recorded", async () => {
    const entries = await page();
    const inbound = entries.find((entry) => entry.ref === "sentinel:answered");
    const outbound = entries.find((entry) => entry.ref === "sentinel:answered:reply");
    expect(inbound?.sender).toEqual({ id: DIRECT, name: null });
    expect(inbound?.conversation).toEqual({ id: DIRECT, name: null, kind: null });
    // Rome's reply: the log does not record Rome as a sender.
    expect(outbound?.sender).toBeUndefined();
    expect(outbound?.conversation?.id).toBe(DIRECT);
  });

  // Exact, so it also pins what stays out: no reply line for `unheard` or for
  // the empty reply on `quiet`, and nothing from the group thread. `quiet` stays
  // in, since only a group on its own channel subtracts its thread.
  it("merges every address of the account into one newest-first history", async () => {
    expect(await refs()).toEqual([
      "sentinel:quiet",
      "sentinel:unheard",
      "sentinel:alt",
      "sentinel:answered:reply",
      "sentinel:answered",
    ]);
  });

  it("names the channel as the source", async () => {
    expect((await page()).every((entry) => entry.source === CHANNEL)).toBe(true);
  });

  it("scopes an address to its own channel", async () => {
    const elsewhere = await sentinelLogMessages(db).read({
      accounts: [{ channel: "discord", addresses: [DIRECT] }],
      limit: WHOLE_HISTORY,
    });
    expect(elsewhere).toEqual([]);
  });
});

// One seeded database for the whole suite: every assertion in it reads, so a
// fresh one per case would only buy migrations.
let enrolled: Promise<MessagesContractSubject> | null = null;

testAccountMessagesContract("sentinelLogMessages", () => {
  enrolled ??= (async () => {
    const { db } = createTestDb();
    await seed(db);
    return {
      messages: sentinelLogMessages(db),
      accounts: [account],
      silent,
    };
  })();
  return enrolled;
});
