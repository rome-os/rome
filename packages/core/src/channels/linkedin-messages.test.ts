import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { countingDb, createTestDb, type TestDb } from "../test/helpers.js";
import { linkedinMessages, linkedinThreadParticipants, linkedinThreads } from "../db/schema.js";
import type { ConversationId } from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";
import {
  testAccountMessagesContract,
  testMessagesQueryContract,
  WHOLE_HISTORY,
} from "./messages-contract.js";
import { linkedInMessages } from "./linkedin-messages.js";
import { channelMessageDetail, type AccountMessages, type MessageAccount } from "./messages.js";

// `linkedin_messages` as a `Messages` store. The mirror holds group threads
// and rooms the guardian is one of many in; a person's history is the threads
// that are a conversation between two people, and that scope is what the cases
// below pin.

const SELF = "ACoAASELF";
const MEMBER = "ACoAAMEMBER";
const OTHER = "ACoAAOTHER";
// One person holding two member ids, both on one thread of their own — the
// case an attribution that answered per participant would show twice.
const TWIN_A = "ACoAATWINA";
const TWIN_B = "ACoAATWINB";

const account = { channel: "linkedin", addresses: [MEMBER] };
const accounts = [account];
const silent = [{ channel: "linkedin", addresses: ["ACoAASILENT"] }];
const room = "t-room" as ConversationId;
const emptyThread = "t-nothing" as ConversationId;

/** The store's per-account reads, which every LinkedIn store answers. */
function accountReads(db: DrizzleDb): AccountMessages {
  const reads = linkedInMessages(db).byAccount;
  if (!reads) throw new Error("the LinkedIn mirror answers per-account reads");
  return reads;
}

interface ThreadSeed {
  thread: string;
  participants: string[];
  isGroup?: boolean | null;
  messages: Array<{ id: string; at: number; self?: boolean; text?: string; sentAt?: boolean }>;
}

const threads: ThreadSeed[] = [
  {
    thread: "t-direct",
    participants: [SELF, MEMBER],
    messages: [
      { id: "a", at: 100, text: "first" },
      // No `sent_at`: the mirror falls back on when it stored the message.
      { id: "b", at: 200, text: "no delivery time", sentAt: false },
      { id: "c", at: 300, self: true, text: "answered" },
      // The same second as `c`; the direction settles the tie.
      { id: "d", at: 300, text: "crossed in flight" },
      { id: "e", at: 500, text: "latest" },
    ],
  },
  // Three on the thread: nobody's direct history, whatever LinkedIn's own flag
  // says about it — and so the thread only a conversation read reaches. Enough
  // of it to page, and a second in it said twice so the ordering has a tie.
  {
    thread: "t-room",
    participants: [SELF, MEMBER, OTHER],
    messages: [
      { id: "f", at: 700, text: "in the room" },
      { id: "f2", at: 700, self: true, text: "answered the room" },
      { id: "f3", at: 750, text: "and again" },
      { id: "f4", at: 800, text: "latest in the room" },
    ],
  },
  // Two on the thread, but LinkedIn calls it a group.
  {
    thread: "t-flagged",
    participants: [SELF, MEMBER],
    isGroup: true,
    messages: [{ id: "g", at: 800, text: "flagged as a group" }],
  },
  {
    thread: "t-other",
    participants: [SELF, OTHER],
    messages: [{ id: "h", at: 900, text: "another member" }],
  },
  {
    thread: "t-twins",
    participants: [TWIN_A, TWIN_B],
    messages: [{ id: "i", at: 1000, text: "one message, two member ids" }],
  },
];

function seedMirror(testDb: TestDb): void {
  const now = new Date();
  testDb.db
    .insert(linkedinThreads)
    .values(
      threads.map((seed) => ({
        threadId: seed.thread,
        threadUrl: `https://www.linkedin.com/messaging/thread/${seed.thread}/`,
        isGroup: seed.isGroup ?? null,
        unread: false,
        firstSyncedAt: now,
        updatedAt: now,
      })),
    )
    .run();

  testDb.db
    .insert(linkedinThreadParticipants)
    .values(
      threads.flatMap((seed) =>
        seed.participants.map((participantId) => ({
          threadId: seed.thread,
          participantId,
          firstSyncedAt: now,
        })),
      ),
    )
    .run();

  testDb.db
    .insert(linkedinMessages)
    .values(
      threads.flatMap((seed) =>
        seed.messages.map((message) => ({
          messageId: message.id,
          threadId: seed.thread,
          sentAt: message.sentAt === false ? null : new Date(message.at * 1000),
          senderIsSelf: message.self ?? false,
          senderName: message.self ? "Self" : "Member",
          senderProfileUrl: `https://www.linkedin.com/in/${message.self ? SELF : MEMBER}/`,
          text: message.text ?? null,
          createdAt: new Date(message.at * 1000),
        })),
      ),
    )
    .run();
}

describe("linkedInMessages", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    seedMirror(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  const refs = (entries: { ref: string }[]) => entries.map((entry) => entry.ref);

  // Exact, so it also pins what stays out: `t-room` is three-handed and
  // `t-flagged` is a group, though both include the member.
  it("answers the member's direct thread, newest first", async () => {
    const messages = accountReads(testDb.db);
    const page = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(refs(page)).toEqual([
      "t-direct:e",
      "t-direct:c",
      "t-direct:d",
      "t-direct:b",
      "t-direct:a",
    ]);
    expect(page[0]).toEqual({
      source: "linkedin",
      timestamp: 500,
      direction: "inbound",
      ref: "t-direct:e",
      body: "latest",
      sender: { id: MEMBER, name: "Member" },
      conversation: { id: "t-direct", name: null, kind: "dm" },
    });
  });

  // A thread is the conversation, named by LinkedIn's own id: what the account
  // scope reaches through membership, a query names outright.
  it("queries a group thread", async () => {
    const page = await linkedInMessages(testDb.db).query({ conversationId: room });
    // Newest first, and the tie at 700 in the mirror's own order.
    expect(page.map((entry) => entry.messageId)).toEqual(["f4", "f3", "f2", "f"]);
    expect(page.find((entry) => entry.messageId === "f2")?.direction).toBe("outbound");
  });

  it("answers a group thread's messages to no account read", async () => {
    const messages = accountReads(testDb.db);
    // Every member of the room, read as the accounts they are: the thread is
    // three-handed, so it is nobody's direct history.
    const members: MessageAccount[] = [SELF, MEMBER, OTHER].map((address) => ({
      channel: "linkedin",
      addresses: [address],
    }));
    const held = await messages.read({ accounts: members, limit: WHOLE_HISTORY });
    expect(refs(held).some((ref) => ref.startsWith("t-room:"))).toBe(false);
    // And the thread id is no member id, so naming it as an address answers
    // nothing at all.
    const asAccount: MessageAccount[] = [{ channel: "linkedin", addresses: ["t-room"] }];
    expect(await messages.read({ accounts: asAccount, limit: WHOLE_HISTORY })).toEqual([]);
    expect(await messages.count(asAccount)).toBe(0);
    expect(await messages.latest(asAccount)).toBeNull();
  });

  it("queries a thread LinkedIn calls a group, as a group", async () => {
    const page = await linkedInMessages(testDb.db).query({
      conversationId: "t-flagged" as ConversationId,
    });
    expect(page.map((entry) => entry.messageId)).toEqual(["g"]);
    expect(page[0]?.thread?.kind).toBe("group");
  });

  // One row, two doors: the account reads and `query` map a row through the
  // same mapper, so they cannot describe one message two ways.
  it("describes a message the same way through both reads", async () => {
    const read = await accountReads(testDb.db).read({ accounts, limit: WHOLE_HISTORY });
    const queried = await linkedInMessages(testDb.db).query({});
    expect(read.length).toBeGreaterThan(0);
    for (const entry of read) {
      const same = queried.find(
        (message) => `${message.conversationId}:${message.messageId}` === entry.ref,
      );
      expect(same).toBeDefined();
      expect({ sender: entry.sender, conversation: entry.conversation }).toEqual(
        channelMessageDetail(same!),
      );
    }
    // The member id the profile URL carries, through either read.
    expect(read[0]?.sender?.id).toBe(MEMBER);
  });

  it("queries a direct thread, reading an undated message at when it was stored", async () => {
    const page = await linkedInMessages(testDb.db).query({
      conversationId: "t-direct" as ConversationId,
    });
    expect(page.map((entry) => entry.messageId)).toEqual(["e", "d", "c", "b", "a"]);
    expect(page[0]).toMatchObject({
      channel: "linkedin",
      direction: "inbound",
      conversationId: "t-direct",
      text: "latest",
      attachments: [],
      thread: { kind: "dm" },
    });
  });

  // The scope is the member ids an account answers to, and the three verbs
  // answer one history over it: `count` is the length of the full read and
  // `latest` its first entry. Per scope rather than once, because a store that
  // scoped `read` one way and `count` another would still agree on the widest
  // scope there is.
  it.each([
    // `t-room` is three-handed and `t-flagged` is a group, so neither is any
    // member's direct history — only `t-other` is.
    {
      of: "a member reached on one direct thread",
      scope: [{ channel: "linkedin", addresses: [OTHER] }],
      refs: ["t-other:h"],
    },
    // One person holding two member ids, both on the thread: one message, not
    // one per participant.
    {
      of: "one account under two member ids",
      scope: [
        { channel: "linkedin", addresses: [TWIN_A] },
        { channel: "linkedin", addresses: [TWIN_B] },
      ],
      refs: ["t-twins:i"],
    },
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

    const [newest, otherNewest, page, tail, total] = await Promise.all([
      messages.latest(accounts),
      messages.latest([{ channel: "linkedin", addresses: [OTHER] }]),
      messages.read({ accounts, limit: 2 }),
      messages.read({ accounts, after: cursor, limit: WHOLE_HISTORY }),
      messages.count(accounts),
    ]);

    expect(counted.passes() - before).toBe(1);
    expect(newest?.ref).toBe("t-direct:e");
    expect(otherNewest?.ref).toBe("t-other:h");
    expect(refs(page)).toEqual(["t-direct:e", "t-direct:c"]);
    expect(refs(tail)).toEqual(["t-direct:c", "t-direct:d", "t-direct:b", "t-direct:a"]);
    expect(total).toBe(5);
  });
});

// One seeded database for both suites: every assertion in them reads, so a
// fresh one per case would only buy migrations.
let enrolled: DrizzleDb | null = null;

function enrolledDb(): DrizzleDb {
  if (!enrolled) {
    const testDb = createTestDb();
    seedMirror(testDb);
    enrolled = testDb.db;
  }
  return enrolled;
}

testAccountMessagesContract("linkedInMessages", () => ({
  messages: accountReads(enrolledDb()),
  accounts,
  silent,
}));

testMessagesQueryContract("linkedInMessages", () => ({
  messages: linkedInMessages(enrolledDb()),
  channel: "linkedin",
  conversation: room,
  silentConversation: emptyThread,
}));
