// THROWAWAY PROTOTYPE TEST — see email-messages.prototype.ts.
//
// Two questions. Does an email mirror over `sqlMessages` pass the contract
// suite? And what does attributing an outbound message to a person cost, given
// that a list row carries no `to`?

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type { RomeMailEvent } from "../lib/rome-cloud-mail.js";
import { testMessagesContract, WHOLE_HISTORY } from "./messages-contract.js";
import {
  backfillEmail,
  createEmailMirrorTables,
  emailMessages,
  type EmailAttribution,
  type FakeMail,
  FakeMailProvider,
  ingestInboundEmail,
} from "./email-messages.prototype.js";
import type { MessageAccount, MessageConversation } from "./messages.js";

// --- the fake mailbox -------------------------------------------------------
//
// 350 messages, 40 threads, 12 correspondents. Thread `t` for t < 39 belongs to
// `person${t % 11}`; thread 39 belongs to `lonely`, is entirely outbound, and
// is the unanswered thread Rome started.

const SELF = "rome@rome.example";
const THREADS = 40;
const TOTAL = 350;
const LONELY = "lonely@example.com";
const LONELY_THREAD = "thread-39";
const BASE = 1_700_000_000;

function correspondentOf(thread: number): string {
  return thread === THREADS - 1 ? LONELY : `person${thread % 11}@example.com`;
}

// 30 threads of 9 and 10 of 8 is 350.
function sizeOf(thread: number): number {
  return thread < 30 ? 9 : 8;
}

function buildMailbox(): FakeMail[] {
  const mailbox: FakeMail[] = [];
  for (let thread = 0; thread < THREADS; thread++) {
    const person = correspondentOf(thread);
    for (let position = 0; position < sizeOf(thread); position++) {
      // Position 2 shares position 1's second, so every thread and every
      // correspondent's history carries the tie the contract demands.
      const tick = position === 2 ? 1 : position;
      const outbound = thread === THREADS - 1 || position % 2 === 1;
      mailbox.push({
        providerMessageId: `msg-${thread}-${position}`,
        threadId: `thread-${thread}`,
        from: outbound ? `Rome <${SELF}>` : `Person ${thread % 11} <${person}>`,
        to: outbound ? person : SELF,
        subject: `thread ${thread}`,
        preview: `line ${position} of thread ${thread}`,
        receivedAt: new Date((BASE + thread * 1000 + tick * 10) * 1000),
        outbound,
      });
    }
  }
  return mailbox;
}

const MAILBOX = buildMailbox();
const OUTBOUND_TOTAL = MAILBOX.filter((m) => m.outbound).length;
const LONELY_TOTAL = MAILBOX.filter((m) => m.threadId === LONELY_THREAD).length;
const PAGES = Math.ceil(TOTAL / 100); // the page cap is the cloud route's 100

function trueCountFor(address: string): number {
  return MAILBOX.filter((m) => correspondentOf(Number(m.threadId.slice("thread-".length))) === address)
    .length;
}

function accountsFor(address: string): MessageAccount[] {
  return [{ channel: "email", addresses: [address] }];
}

async function mirrored(testDb: TestDb, attribution: EmailAttribution) {
  const provider = new FakeMailProvider(MAILBOX, SELF);
  await backfillEmail(testDb.db, provider, { self: SELF, attribution });
  return { provider, messages: emailMessages(testDb.db) };
}

function rowCount(testDb: TestDb): number {
  const [row] = testDb.db.all(sql`SELECT count(*) AS n FROM email_messages_proto`) as Array<{
    n: number;
  }>;
  return row.n;
}

describe("email mirror prototype", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    createEmailMirrorTables(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("backfills the whole mailbox off the paged list", async () => {
    const provider = new FakeMailProvider(MAILBOX, SELF);
    const seen = await backfillEmail(testDb.db, provider, { self: SELF });
    expect(seen).toBe(TOTAL);
    expect(rowCount(testDb)).toBe(TOTAL);
    expect(provider.calls()).toEqual({ list: PAGES, getMessage: 0 });
  });

  it("is idempotent across a rerun", async () => {
    const provider = new FakeMailProvider(MAILBOX, SELF);
    await backfillEmail(testDb.db, provider, { self: SELF, attribution: "both" });
    const first = await emailMessages(testDb.db).read({
      accounts: accountsFor("person0@example.com"),
      limit: WHOLE_HISTORY,
    });

    provider.reset();
    await backfillEmail(testDb.db, provider, { self: SELF, attribution: "both" });
    expect(rowCount(testDb)).toBe(TOTAL);
    const second = await emailMessages(testDb.db).read({
      accounts: accountsFor("person0@example.com"),
      limit: WHOLE_HISTORY,
    });
    expect(second).toEqual(first);
    // The walk is paid again; the hydration is not, because a row that already
    // carries a recipient is never re-fetched.
    expect(provider.calls()).toEqual({ list: PAGES, getMessage: 0 });
  });

  // The measured column of the report. `M` is 350, the page cap 100.
  it.each([
    { attribution: "thread" as const, getMessage: 0 },
    { attribution: "message" as const, getMessage: OUTBOUND_TOTAL },
    { attribution: "both" as const, getMessage: LONELY_TOTAL },
  ])("costs $getMessage getMessage calls under $attribution attribution", async (row) => {
    const { provider } = await mirrored(testDb, row.attribution);
    expect(provider.calls()).toEqual({ list: PAGES, getMessage: row.getMessage });
  });

  it.each([
    { attribution: "thread" as const, lonely: 0 },
    { attribution: "message" as const, lonely: LONELY_TOTAL },
    { attribution: "both" as const, lonely: LONELY_TOTAL },
  ])(
    "attributes the unanswered thread to $lonely messages under $attribution",
    async ({ attribution, lonely }) => {
      const { messages } = await mirrored(testDb, attribution);
      expect(await messages.count(accountsFor(LONELY))).toBe(lonely);
    },
  );

  it.each(["thread", "message", "both"] as const)(
    "attributes every answered correspondent under %s",
    async (attribution) => {
      const { messages } = await mirrored(testDb, attribution);
      for (let person = 0; person < 11; person++) {
        const address = `person${person}@example.com`;
        expect(await messages.count(accountsFor(address))).toBe(trueCountFor(address));
      }
    },
  );

  it("attributes every message of the mailbox to somebody under both", async () => {
    const { messages } = await mirrored(testDb, "both");
    const everyone = [
      ...Array.from({ length: 11 }, (_, i) => `person${i}@example.com`),
      LONELY,
    ].map((address) => ({ channel: "email", addresses: [address] }));
    expect(await messages.count(everyone)).toBe(TOTAL);
  });

  it("reads a thread as a conversation whether or not it was attributed", async () => {
    const { messages } = await mirrored(testDb, "thread");
    const page = await messages.readConversation({
      conversation: { channel: "email", id: LONELY_THREAD },
      limit: WHOLE_HISTORY,
    });
    expect(page.length).toBe(LONELY_TOTAL);
    expect(page.every((entry) => entry.direction === "outbound")).toBe(true);
  });

  it("dedupes a push-ingested message against its backfilled copy", async () => {
    const pushed = MAILBOX.find((m) => !m.outbound);
    if (!pushed) throw new Error("the mailbox holds no inbound message");
    const event: RomeMailEvent = {
      type: "message.received",
      provider: "fake",
      mailboxAddress: SELF,
      id: `evt-${pushed.providerMessageId}`,
      providerMessageId: pushed.providerMessageId,
      threadId: pushed.threadId,
      from: [{ email: correspondentOf(Number(pushed.threadId.slice(7))) }],
      to: [{ email: SELF }],
      subject: pushed.subject,
      preview: pushed.preview,
      receivedAt: pushed.receivedAt.toISOString(),
      hasAttachment: false,
      attachments: [],
      authentication: { authenticated: true, spam: false, blocked: false },
      labels: ["inbox"],
    };

    // Push first, backfill second — the order a live instance hits.
    ingestInboundEmail(testDb.db, event);
    expect(rowCount(testDb)).toBe(1);
    const provider = new FakeMailProvider(MAILBOX, SELF);
    await backfillEmail(testDb.db, provider, { self: SELF, attribution: "both" });
    expect(rowCount(testDb)).toBe(TOTAL);

    const messages = emailMessages(testDb.db);
    const address = correspondentOf(0);
    const page = await messages.read({ accounts: accountsFor(address), limit: WHOLE_HISTORY });
    expect(page.filter((entry) => entry.ref === pushed.providerMessageId).length).toBe(1);
    expect(page.length).toBe(trueCountFor(address));

    // And the other way round: backfill first, then a redelivered push.
    ingestInboundEmail(testDb.db, event);
    expect(rowCount(testDb)).toBe(TOTAL);
  });
});

// The contract suite, over the mirror as `both` attribution leaves it.
testMessagesContract("emailMessages (prototype)", async () => {
  const testDb = createTestDb();
  createEmailMirrorTables(testDb.db);
  const provider = new FakeMailProvider(MAILBOX, SELF);
  await backfillEmail(testDb.db, provider, { self: SELF, attribution: "both" });
  const conversation: MessageConversation = { channel: "email", id: "thread-0" };
  const silentConversation: MessageConversation = { channel: "email", id: "thread-none" };
  return {
    messages: emailMessages(testDb.db),
    accounts: accountsFor("person0@example.com"),
    silent: accountsFor("nobody@example.com"),
    conversation,
    silentConversation,
  };
});
