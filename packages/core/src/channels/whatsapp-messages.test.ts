import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { countingDb, createTestDb, type TestDb } from "../test/helpers.js";
import type { ConversationId } from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";
import { waChats, waContacts, waMessages } from "../db/schema.js";
import {
  testAccountMessagesContract,
  testMessagesQueryContract,
  WHOLE_HISTORY,
} from "./messages-contract.js";
import { WHATSAPP_SELF_SENDER } from "./whatsapp-history.js";
import { whatsAppMessages } from "./whatsapp-messages.js";
import { channelMessageDetail, type AccountMessages, type MessageAccount } from "./messages.js";

// `wa_messages` as a `Messages` store. What it must answer is the contract
// suites'; what the account reads must leave out is the mirror's own scoping —
// a group thread, a reaction, another contact — which is what the cases below
// pin.

// One account, addressed both ways WhatsApp addresses a contact.
const PHONE = "15550001@s.whatsapp.net";
const LID = "8877@lid";
// A second contact, and a group. Neither is in any scope below.
const OTHER = "15559999@s.whatsapp.net";
const GROUP = "1200000@g.us";

const account = { channel: "whatsapp", addresses: [PHONE, LID] };
const accounts = [account];
const silent = [{ channel: "whatsapp", addresses: ["15554444@s.whatsapp.net"] }];
const groupChat = GROUP as ConversationId;
const emptyChat = "1299999@g.us" as ConversationId;

/** The store's per-account reads, which every whatsApp store answers. */
function accountReads(db: DrizzleDb): AccountMessages {
  const reads = whatsAppMessages(db).byAccount;
  if (!reads) throw new Error("the WhatsApp mirror answers per-account reads");
  return reads;
}

interface Seed {
  id: string;
  chat: string;
  at: number;
  fromMe?: boolean;
  type?: string;
  text?: string;
}

const seeds: Seed[] = [
  { id: "a", chat: PHONE, at: 100, text: "first" },
  { id: "c", chat: PHONE, at: 300, fromMe: true, text: "answered" },
  // The same second as `c`, on the account's other address: the direction
  // settles the tie, and both have to survive a page boundary.
  { id: "d", chat: LID, at: 300, text: "and on the lid" },
  { id: "e", chat: PHONE, at: 500, text: "latest" },
  // Out of every account's scope, each for its own reason.
  { id: "r", chat: PHONE, at: 600, type: "reaction", text: "👍" },
  { id: "o", chat: OTHER, at: 800, text: "another contact" },
  // The group, which only a conversation read reaches. Enough of it to page,
  // and a second in it said twice so the ordering has a tie to settle.
  { id: "g", chat: GROUP, at: 700, text: "in the group" },
  { id: "g2", chat: GROUP, at: 700, fromMe: true, text: "answered the group" },
  { id: "g3", chat: GROUP, at: 750, text: "and again" },
  { id: "g4", chat: GROUP, at: 760, text: "latest in the group" },
  { id: "gr", chat: GROUP, at: 770, type: "reaction", text: "👍" },
];

function seedMirror(testDb: TestDb): void {
  const now = new Date();
  testDb.db
    .insert(waMessages)
    .values(
      seeds.map((seed) => ({
        id: seed.id,
        chatJid: seed.chat,
        senderJid: seed.fromMe ? null : seed.chat,
        fromMe: seed.fromMe ?? false,
        timestamp: new Date(seed.at * 1000),
        type: seed.type ?? "text",
        text: seed.text ?? null,
        hasMedia: false,
        createdAt: now,
      })),
    )
    .run();
}

describe("whatsAppMessages", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    seedMirror(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  const refs = (entries: { ref: string }[]) => entries.map((entry) => entry.ref);

  it("merges both addresses of the account, newest first", async () => {
    const messages = accountReads(testDb.db);
    const page = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(refs(page)).toEqual([`${PHONE}:e`, `${PHONE}:c`, `${LID}:d`, `${PHONE}:a`]);
    expect(page[0]).toEqual({
      source: "whatsapp",
      timestamp: 500,
      direction: "inbound",
      ref: `${PHONE}:e`,
      body: "latest",
      sender: { id: PHONE, name: PHONE },
      conversation: { id: PHONE, name: null, kind: "dm" },
    });
  });

  it("leaves out reactions", async () => {
    const messages = accountReads(testDb.db);
    const page = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(refs(page)).not.toContain(`${PHONE}:r`);
  });

  it("leaves out group threads", async () => {
    const messages = accountReads(testDb.db);
    const group: MessageAccount[] = [{ channel: "whatsapp", addresses: [GROUP] }];
    expect(await messages.latest(group)).toBeNull();
    expect(await messages.count(group)).toBe(0);
  });

  // The chat is the conversation: a WhatsApp message hangs off it, and a group
  // chat is the one no account can name.
  it("queries a group chat, reactions and all", async () => {
    const page = await whatsAppMessages(testDb.db).query({ conversationId: groupChat });
    // Newest first, and the tie at 700 in the mirror's own order.
    expect(page.map((entry) => entry.messageId)).toEqual(["gr", "g4", "g3", "g2", "g"]);
    expect(page.find((entry) => entry.messageId === "gr")?.text).toBe("Reacted 👍");
    expect(page.find((entry) => entry.messageId === "g2")?.direction).toBe("outbound");
  });

  it("answers a group chat's messages to no account read", async () => {
    const messages = accountReads(testDb.db);
    const held = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(refs(held).some((ref) => ref.startsWith(GROUP))).toBe(false);
    // Nor to a caller that hands the group's own JID over as an address.
    const asAccount: MessageAccount[] = [{ channel: "whatsapp", addresses: [GROUP] }];
    expect(await messages.read({ accounts: asAccount, limit: WHOLE_HISTORY })).toEqual([]);
    expect(await messages.count(asAccount)).toBe(0);
    expect(await messages.latest(asAccount)).toBeNull();
  });

  it("queries a direct chat by the contact's address", async () => {
    const page = await whatsAppMessages(testDb.db).query({
      conversationId: PHONE as ConversationId,
    });
    expect(page.map((entry) => entry.messageId)).toEqual(["r", "e", "c", "a"]);
  });

  // One row, two doors: the account reads and `query` map a row through the
  // same mapper, so they cannot describe one message two ways.
  it("describes a message the same way through both reads", async () => {
    const now = new Date();
    testDb.db
      .insert(waContacts)
      .values({ jid: PHONE, name: "Ada", firstSyncedAt: now, updatedAt: now })
      .run();
    const store = whatsAppMessages(testDb.db);
    const read = await accountReads(testDb.db).read({ accounts, limit: WHOLE_HISTORY });
    const queried = await store.query({});
    for (const entry of read) {
      const same = queried.find(
        (message) => `${message.conversationId}:${message.messageId}` === entry.ref,
      );
      expect(same).toBeDefined();
      expect({ sender: entry.sender, conversation: entry.conversation }).toEqual(
        channelMessageDetail(same!),
      );
    }
    // The guardian's line in a direct chat, which the sync stores with no sender.
    expect(read.find((entry) => entry.ref === `${PHONE}:c`)?.sender).toEqual({
      id: WHATSAPP_SELF_SENDER,
      name: "You",
    });
  });

  it("reads `since` as an instant, not as the second it falls in", async () => {
    const page = await whatsAppMessages(testDb.db).query({
      conversationId: PHONE as ConversationId,
      since: new Date(300_500),
    });
    expect(page.map((entry) => entry.messageId)).toEqual(["r", "e"]);
  });

  it("names the sender and the chat from the mirror's contacts", async () => {
    const now = new Date();
    testDb.db
      .insert(waContacts)
      .values({ jid: PHONE, name: "Ada", firstSyncedAt: now, updatedAt: now })
      .run();
    testDb.db.insert(waChats).values({ jid: GROUP, name: "Book club", updatedAt: now }).run();
    const store = whatsAppMessages(testDb.db);

    const [latest] = await store.query({ conversationId: PHONE as ConversationId, limit: 2 });
    expect(latest).toMatchObject({
      channel: "whatsapp",
      direction: "inbound",
      conversationId: PHONE,
      senderId: PHONE,
      thread: { kind: "dm", name: "Ada" },
    });
    const [answered] = await store
      .query({
        conversationId: PHONE as ConversationId,
        since: new Date(300_000),
      })
      .then((page) => page.filter((entry) => entry.messageId === "c"));
    // The sync records no sender for the guardian's line in a direct chat, and
    // the chat's JID is the contact's, so the line is marked as the guardian's.
    expect(answered).toMatchObject({
      direction: "outbound",
      senderId: WHATSAPP_SELF_SENDER,
      senderDisplayName: "You",
    });
    const [group] = await store.query({ conversationId: groupChat, limit: 1 });
    expect(group?.thread).toEqual({ kind: "group", name: "Book club" });

    const read = await accountReads(testDb.db).latest(accounts);
    expect(read?.conversation).toEqual({ id: PHONE, name: "Ada", kind: "dm" });
    expect(read?.sender).toEqual({ id: PHONE, name: "Ada" });
  });

  it("holds nothing for an account on another channel", async () => {
    const messages = accountReads(testDb.db);
    // The same string, on a channel this store does not serve.
    const elsewhere: MessageAccount[] = [{ channel: "linkedin", addresses: [PHONE] }];
    expect(await messages.latest(elsewhere)).toBeNull();
    expect(await messages.count(elsewhere)).toBe(0);
    expect(await messages.read({ accounts: elsewhere, limit: WHOLE_HISTORY })).toEqual([]);
  });

  it("holds nothing for an empty scope", async () => {
    const messages = accountReads(testDb.db);
    expect(await messages.latest([])).toBeNull();
    expect(await messages.count([])).toBe(0);
    expect(await messages.read({ accounts: [], limit: WHOLE_HISTORY })).toEqual([]);
  });

  // The scope is the account's address set, and the three verbs answer one
  // history over it: `count` is the length of the full read and `latest` its
  // first entry. Per scope rather than once, because a store that scoped `read`
  // one way and `count` another would still agree on the widest scope there is.
  it.each([
    {
      scope: accounts,
      of: "both addresses of the account",
      refs: [`${PHONE}:e`, `${PHONE}:c`, `${LID}:d`, `${PHONE}:a`],
    },
    // `d` arrived on the `@lid` address, so a scope naming only the phone
    // leaves it out — the address set is the scope, not the account.
    {
      scope: [{ channel: "whatsapp", addresses: [PHONE] }],
      of: "one address",
      refs: [`${PHONE}:e`, `${PHONE}:c`, `${PHONE}:a`],
    },
    { scope: silent, of: "a contact the mirror holds nothing for", refs: [] },
  ])("answers read, count and latest over $of", async ({ scope, refs: expected }) => {
    const messages = accountReads(testDb.db);
    const page = await messages.read({ accounts: scope, limit: WHOLE_HISTORY });

    expect(refs(page)).toEqual(expected);
    expect(await messages.count(scope)).toBe(page.length);
    expect(await messages.latest(scope)).toEqual(page[0] ?? null);
  });

  it("serves concurrent latest and read calls from one store pass", async () => {
    const cursor = await accountReads(testDb.db).latest(accounts);
    if (!cursor) throw new Error("the mirror answered nothing to resume from");

    const counted = countingDb(testDb.db);
    const messages = accountReads(counted.db);
    const before = counted.passes();

    // Every shape at once — two scopes, a first page, a page resuming from a
    // cursor, and a count — because a batch that only served identical
    // requests would not be serving the directory read this exists for.
    const [newest, otherNewest, page, tail, total] = await Promise.all([
      messages.latest(accounts),
      messages.latest([{ channel: "whatsapp", addresses: [OTHER] }]),
      messages.read({ accounts, limit: 2 }),
      messages.read({ accounts, after: cursor, limit: WHOLE_HISTORY }),
      messages.count(accounts),
    ]);

    expect(counted.passes() - before).toBe(1);
    expect(newest?.ref).toBe(`${PHONE}:e`);
    expect(otherNewest?.ref).toBe(`${OTHER}:o`);
    expect(refs(page)).toEqual([`${PHONE}:e`, `${PHONE}:c`]);
    expect(refs(tail)).toEqual([`${PHONE}:c`, `${LID}:d`, `${PHONE}:a`]);
    expect(total).toBe(4);
  });

  it("costs one pass per round of calls, not one per account", async () => {
    const counted = countingDb(testDb.db);
    const messages = accountReads(counted.db);
    const directory = [PHONE, LID, OTHER, GROUP, "15554444@s.whatsapp.net"].map(
      (address): MessageAccount[] => [{ channel: "whatsapp", addresses: [address] }],
    );

    const before = counted.passes();
    await Promise.all(directory.map((row) => messages.latest(row)));
    expect(counted.passes() - before).toBe(1);
  });
});

testAccountMessagesContract("whatsAppMessages", () => {
  const testDb = createTestDb();
  seedMirror(testDb);
  return { messages: accountReads(testDb.db), accounts, silent };
});

testMessagesQueryContract("whatsAppMessages", () => {
  const testDb = createTestDb();
  seedMirror(testDb);
  return {
    messages: whatsAppMessages(testDb.db),
    channel: "whatsapp",
    conversation: groupChat,
    silentConversation: emptyChat,
  };
});
