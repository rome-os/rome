// The stream read, over the `Messages` stores.
//
// The stream is the recents surface: the accounts something has happened on,
// each previewing the newest thing that happened. What makes that preview
// trustworthy is that it comes from the same stores, claimed in the same order,
// as the timeline the row opens onto — so these tests mostly assert one thing,
// that a row's preview is the head of that account's own timeline, and then pin
// the cases where reading a mirror's activity summary instead used to answer
// something else.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { latestDynamic, type StreamAccount } from "@rome/api-types/people";
import { romeAgentMessages, romeSessions } from "../db/schema.js";
import {
  buildTestDeps,
  countingDb,
  createTestDb,
  type TestDb,
  type TestDeps,
} from "../test/helpers.js";
import { seedBaseline } from "../test/seeds.js";
import { readAccountStream } from "./account-directory.js";
import { readPersonTimeline } from "./timeline.js";
import { personMessageStores } from "./timeline-sources.js";

/** A WhatsApp contact the mirror holds a conversation for, and whom the
 *  sentinel also logged — more recently than the mirror's newest message. */
const MIRRORED_JID = "15550002222@s.whatsapp.net";
/** A contact the address book holds and nobody has ever written to. */
const SILENT_JID = "15550001111@s.whatsapp.net";
/** A Telegram sender the sentinel triaged and answered. */
const TRIAGED = "tg-triaged";
/** A Telegram account whose whole conversation is Rome's own transcript: no
 *  mirror holds the channel, and the sentinel never saw it. */
const TRANSCRIBED = "tg-transcribed";

const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const line = (text: string) => JSON.stringify([{ type: "text", content: text }]);

describe("readAccountStream", () => {
  let testDb: TestDb;
  let deps: TestDeps;

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);

    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: SILENT_JID, phoneNumber: "15550001111", name: "Silent Sam" },
      { jid: MIRRORED_JID, phoneNumber: "15550002222", name: "Talky Tina" },
    ]);
    await deps.whatsAppStoreRepo.upsertMessages([
      {
        id: "wa-1",
        chatJid: MIRRORED_JID,
        senderJid: MIRRORED_JID,
        fromMe: false,
        timestamp: new Date("2026-08-17T10:00:00Z"),
        type: "text",
        text: "hello from the mirror",
        hasMedia: false,
      },
    ]);
    // Filed later than anything the mirror holds for the same contact. The
    // mirror is still the fuller record of a WhatsApp conversation, so it owns
    // the account outright — which is what the timeline does too.
    await deps.sentinelLogRepo.create({
      messageId: "msg-wa-1",
      channel: "whatsapp",
      channelUserId: MIRRORED_JID,
      displayName: "Talky Tina",
      text: "and later, from the triage record",
      action: "ignored",
    });

    // A triaged sender Rome answered. The log holds one row and it is two
    // lines: what they said, and what Rome said back.
    await deps.sentinelLogRepo.create({
      messageId: "msg-tg-1",
      channel: "telegram",
      channelUserId: TRIAGED,
      displayName: "Trish",
      text: "is anyone there?",
      response: "Rome answered on the spot",
      action: "replied",
    });

    // A mapped Telegram account whose conversation lives only in Rome's own
    // transcript.
    await deps.personMappingRepo.create({
      displayName: "Transcribed Tam",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: TRANSCRIBED }],
    });
    await testDb.db.insert(romeSessions).values({
      id: "s-transcribed",
      name: "s-transcribed",
      type: "channel",
      sourceChannel: "telegram",
      sourceThreadId: TRANSCRIBED,
      sourceThreadType: "private",
      createdAt: new Date(0),
      activityAt: new Date(0),
    });
    await testDb.db.insert(romeAgentMessages).values({
      id: "m-transcribed",
      sessionId: "s-transcribed",
      role: "user",
      content: line("only Rome's transcript holds this"),
      senderId: null,
      createdAt: new Date("2026-08-18T09:00:00Z"),
    });
  });

  afterEach(() => testDb.close());

  const find = (stream: StreamAccount[], channel: string, channelUserId: string) =>
    stream.find(
      (account) => account.channel === channel && account.channelUserId === channelUserId,
    );

  /** The head of the timeline the row opens onto, read the way the person page
   *  reads it. */
  async function timelineHead(account: { channel: string; addresses: string[] }) {
    const page = await readPersonTimeline(
      personMessageStores(deps),
      [{ channel: account.channel, addresses: account.addresses }],
      { limit: 1 },
    );
    return latestDynamic(page.entries);
  }

  it("previews exactly the entry the account's own timeline opens on", async () => {
    const stream = await readAccountStream(deps);
    expect(stream.length).toBeGreaterThan(0);
    for (const account of stream) {
      expect(account.latest).toEqual(await timelineHead(account));
    }
  });

  it("previews the mirror's conversation over a later triage row for the same account", async () => {
    const tina = find(await readAccountStream(deps), "whatsapp", MIRRORED_JID)!;
    // Not "and later, from the triage record", though that is the newer of the
    // two: the mirror holds this account's conversation, so it owns the row,
    // and the timeline beneath opens on the same line.
    expect(tina.latest.preview).toBe("hello from the mirror");
    expect(tina.latest.source).toBe("whatsapp");
    expect(tina.latest.timestamp).toBe(at("2026-08-17T10:00:00Z"));
  });

  it("previews Rome's own reply when that is what the log's newest line is", async () => {
    const trish = find(await readAccountStream(deps), "telegram", TRIAGED)!;
    expect(trish.latest.preview).toBe("Rome answered on the spot");
  });

  it("carries an account whose whole conversation is Rome's transcript", async () => {
    const tam = find(await readAccountStream(deps), "telegram", TRANSCRIBED)!;
    expect(tam.latest.preview).toBe("only Rome's transcript holds this");
    expect(tam.latest.timestamp).toBe(at("2026-08-18T09:00:00Z"));
  });

  it("leaves out an account no store answers anything for", async () => {
    // Silence is not a flag a producer sets: it is `latest` answering nothing.
    const stream = await readAccountStream(deps);
    expect(find(stream, "whatsapp", SILENT_JID)).toBeUndefined();
    expect(await timelineHead({ channel: "whatsapp", addresses: [SILENT_JID] })).toBeNull();
  });

  it("says nothing about how much is on record", async () => {
    // No per-account count is read on this surface, so none is carried: a row
    // cannot show a number no read computed.
    for (const account of await readAccountStream(deps)) {
      expect(account).not.toHaveProperty("messageCount");
    }
  });

  it("costs one grouped pass per store however many accounts are on the stream", async () => {
    const counted = countingDb(testDb.db);
    // Only the message stores are built from `deps.db`; the address books and
    // the triage record come from repositories on the unwrapped handle. So what
    // this counts is exactly the passes the stream makes over the histories.
    const streamed = { ...deps, db: counted.db };

    const before = counted.passes();
    const small = await readAccountStream(streamed);
    const passes = counted.passes() - before;
    // One per store with anything in scope: the WhatsApp mirror, Rome's
    // transcript, and the triage record. The LinkedIn mirror is asked about no
    // LinkedIn account here, and a store with an empty scope answers without a
    // query at all.
    expect(passes).toBe(3);

    // Twenty more contacts, every one of them talking, on a channel already in
    // the scope. Served a query per row this would cost twenty passes more.
    await deps.whatsAppStoreRepo.upsertContacts(
      Array.from({ length: 20 }, (_, i) => ({
        jid: `1555100${String(i).padStart(4, "0")}@s.whatsapp.net`,
        phoneNumber: `1555100${String(i).padStart(4, "0")}`,
        name: `Crowd ${i}`,
      })),
    );
    await deps.whatsAppStoreRepo.upsertMessages(
      Array.from({ length: 20 }, (_, i) => ({
        id: `wa-crowd-${i}`,
        chatJid: `1555100${String(i).padStart(4, "0")}@s.whatsapp.net`,
        senderJid: `1555100${String(i).padStart(4, "0")}@s.whatsapp.net`,
        fromMe: false,
        timestamp: new Date("2026-08-19T10:00:00Z"),
        type: "text",
        text: `crowd line ${i}`,
        hasMedia: false,
      })),
    );

    const after = counted.passes();
    const big = await readAccountStream(streamed);
    expect(big.length).toBe(small.length + 20);
    expect(counted.passes() - after).toBe(passes);
  });

  it("answers an address book too wide for one statement", async () => {
    // A SQL store answers a round in one statement, binding about six variables
    // per account in it, and SQLite refuses a statement carrying more than
    // 32,766 — so one unsplit round runs out somewhere above five thousand
    // accounts. This is the read that asks about a whole address book, and an
    // address book reaches this size, so asked all at once it fails outright
    // with "too many SQL variables" instead of answering a stream.
    const CONTACTS = 6000;
    const jid = (i: number) => `1555${String(i).padStart(7, "0")}@s.whatsapp.net`;
    await deps.whatsAppStoreRepo.upsertContacts(
      Array.from({ length: CONTACTS }, (_, i) => ({
        jid: jid(i),
        phoneNumber: `1555${String(i).padStart(7, "0")}`,
        name: `Contact ${i}`,
      })),
    );
    await deps.whatsAppStoreRepo.upsertMessages(
      Array.from({ length: CONTACTS }, (_, i) => ({
        id: `wa-bulk-${i}`,
        chatJid: jid(i),
        senderJid: jid(i),
        fromMe: false,
        timestamp: new Date("2026-08-19T10:00:00Z"),
        type: "text",
        text: `line ${i}`,
        hasMedia: false,
      })),
    );

    const counted = countingDb(testDb.db);
    const before = counted.passes();
    const stream = await readAccountStream({ ...deps, db: counted.db });

    expect(stream.length).toBeGreaterThanOrEqual(CONTACTS);
    expect(find(stream, "whatsapp", jid(CONTACTS - 1))?.latest.preview).toBe(
      `line ${CONTACTS - 1}`,
    );
    // Split into rounds, not into one read per account: a few passes per store,
    // nowhere near the thousands a per-row read would cost.
    expect(counted.passes() - before).toBeLessThan(20);
  }, 60_000);
});
