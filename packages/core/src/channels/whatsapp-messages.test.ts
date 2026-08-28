import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { countingDb, createTestDb, type TestDb } from "../test/helpers.js";
import { waMessages } from "../db/schema.js";
import { testMessagesContract, WHOLE_HISTORY } from "./messages-contract.js";
import { whatsAppMessages } from "./whatsapp-messages.js";
import type { MessageAccount } from "./messages.js";

// `wa_messages` as a `Messages` store. What it must answer is the contract
// suite's; what it must leave out is the mirror's own scoping — a group thread,
// a reaction, another contact — which is what the cases below pin.

// One account, addressed both ways WhatsApp addresses a contact.
const PHONE = "15550001@s.whatsapp.net";
const LID = "8877@lid";
// A second contact, and a group. Neither is in any scope below.
const OTHER = "15559999@s.whatsapp.net";
const GROUP = "1200000@g.us";

const account = { channel: "whatsapp", addresses: [PHONE, LID] };
const accounts = [account];
const silent = [{ channel: "whatsapp", addresses: ["15554444@s.whatsapp.net"] }];

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
  // Out of scope, each for its own reason.
  { id: "r", chat: PHONE, at: 600, type: "reaction", text: "👍" },
  { id: "g", chat: GROUP, at: 700, text: "in the group" },
  { id: "o", chat: OTHER, at: 800, text: "another contact" },
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
    const messages = whatsAppMessages(testDb.db);
    const page = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(refs(page)).toEqual([`${PHONE}:e`, `${PHONE}:c`, `${LID}:d`, `${PHONE}:a`]);
    expect(page[0]).toEqual({
      source: "whatsapp",
      timestamp: 500,
      direction: "inbound",
      ref: `${PHONE}:e`,
      body: "latest",
    });
  });

  it("leaves out reactions", async () => {
    const messages = whatsAppMessages(testDb.db);
    const page = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(refs(page)).not.toContain(`${PHONE}:r`);
  });

  it("leaves out group threads", async () => {
    const messages = whatsAppMessages(testDb.db);
    const group: MessageAccount[] = [{ channel: "whatsapp", addresses: [GROUP] }];
    expect(await messages.latest(group)).toBeNull();
    expect(await messages.count(group)).toBe(0);
  });

  it("holds nothing for an account on another channel", async () => {
    const messages = whatsAppMessages(testDb.db);
    // The same string, on a channel this store does not serve.
    const elsewhere: MessageAccount[] = [{ channel: "linkedin", addresses: [PHONE] }];
    expect(await messages.latest(elsewhere)).toBeNull();
    expect(await messages.count(elsewhere)).toBe(0);
    expect(await messages.read({ accounts: elsewhere, limit: WHOLE_HISTORY })).toEqual([]);
  });

  it("holds nothing for an empty scope", async () => {
    const messages = whatsAppMessages(testDb.db);
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
    const messages = whatsAppMessages(testDb.db);
    const page = await messages.read({ accounts: scope, limit: WHOLE_HISTORY });

    expect(refs(page)).toEqual(expected);
    expect(await messages.count(scope)).toBe(page.length);
    expect(await messages.latest(scope)).toEqual(page[0] ?? null);
  });

  it("serves concurrent latest and read calls from one store pass", async () => {
    const cursor = await whatsAppMessages(testDb.db).latest(accounts);
    if (!cursor) throw new Error("the mirror answered nothing to resume from");

    const counted = countingDb(testDb.db);
    const messages = whatsAppMessages(counted.db);
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
    const messages = whatsAppMessages(counted.db);
    const directory = [PHONE, LID, OTHER, GROUP, "15554444@s.whatsapp.net"].map(
      (address): MessageAccount[] => [{ channel: "whatsapp", addresses: [address] }],
    );

    const before = counted.passes();
    await Promise.all(directory.map((row) => messages.latest(row)));
    expect(counted.passes() - before).toBe(1);
  });
});

testMessagesContract("whatsAppMessages", () => {
  const testDb = createTestDb();
  seedMirror(testDb);
  return { messages: whatsAppMessages(testDb.db), accounts, silent };
});
