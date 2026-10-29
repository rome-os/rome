import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Account, ChatId, StoredChatSettings } from "@rome-os/app-runtime";
import type Database from "better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import { romeAgentMessages, romeSessions } from "../db/schema.js";
import { channelChatId, isChannelConversation } from "../db/session-kind.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatRefusal } from "./chat.js";
import { ChatRepository, type ChatChannels } from "./chat-repository.js";
import { chatKey } from "./place.js";

// Chats over today's channel rows. What these pin: a chat is one row per one
// of Rome's accounts in it, read as one chat; a write reaches every row; and
// the rows stay what the legacy readers expect.

const SALES: Account = { platform: "feishu", id: "ou_sales" };
const SUPPORT: Account = { platform: "feishu", id: "ou_support" };
const ALICE: Account = { platform: "feishu", id: "ou_alice" };
const GROUP = chatKey("feishu", "oc_group" as ChatId);

const RULE: StoredChatSettings = {
  schemaVersion: 1,
  overrides: { activation: { mode: "all" } },
  updatedAt: "2026-10-29T00:00:00.000Z",
  updatedBy: { kind: "guardian" },
};

/** Two recorded Feishu channels, and a Telegram one no record holds. */
const channels: ChatChannels = {
  namesOn: (platform) => (platform === "feishu" ? ["feishu", "feishu-2"] : []),
  accountOf: (name) => (name === "feishu" ? SALES : name === "feishu-2" ? SUPPORT : null),
  platformOfChannel: (name) => (name.startsWith("feishu") ? "feishu" : name),
};

describe("ChatRepository", () => {
  let testDb: TestDb;
  let chats: ChatRepository;

  beforeEach(() => {
    testDb = createTestDb();
    chats = new ChatRepository(testDb.db, channels);
  });
  afterEach(() => testDb.close());

  const row = (channel: string, id: string) =>
    testDb.db
      .select()
      .from(romeSessions)
      .where(eq(romeSessions.id, channelChatId(channel, id)))
      .get();

  it("starts a chat as the row of the channel it reached Rome through", () => {
    const chat = chats.startIfMissing(GROUP, "group", SALES, "Launch", { agentName: "sales" });

    expect(chat.participants).toEqual([{ account: SALES, romes: true }]);
    expect(row("feishu", "oc_group")).toMatchObject({
      type: "channel",
      sourceChannel: "feishu",
      sourceThreadId: "oc_group",
      sourceThreadName: "Launch",
      name: "Launch",
      agentName: "sales",
      participants: null,
    });
    expect(chats.byKey(GROUP)?.state()).toMatchObject({ kind: "group", name: "Launch" });
  });

  it("returns the chat it already holds without writing again", () => {
    chats.startIfMissing(GROUP, "group", SALES, "Launch");
    chats.startIfMissing(GROUP, "dm", SALES, "Other", { agentName: "x" });

    expect(row("feishu", "oc_group")).toMatchObject({
      sourceThreadName: "Launch",
      agentName: null,
    });
  });

  it("reads a group two of Rome's accounts are in as one chat", () => {
    chats.startIfMissing(GROUP, "group", SALES, "Launch");
    const chat = chats.startIfMissing(GROUP, "group", SUPPORT, "Launch");

    expect(chat.participants).toEqual([
      { account: SALES, romes: true },
      { account: SUPPORT, romes: true },
    ]);
    expect(row("feishu-2", "oc_group")).toBeDefined();
    expect(chats.byKey(GROUP)?.participants).toHaveLength(2);
  });

  it("writes the reply rule to every row of the chat", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);
    chats.startIfMissing(GROUP, "group", SUPPORT, null);

    chats.update(GROUP, (chat) => chat.setReplyRule(SUPPORT, RULE));

    expect(row("feishu", "oc_group")?.channelSettings).toEqual(RULE);
    expect(row("feishu-2", "oc_group")?.channelSettings).toEqual(RULE);
    expect(chats.byKey(GROUP)?.replyRule).toEqual(RULE);
  });

  it("stores nothing when the change is refused", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);

    expect(() =>
      chats.update(GROUP, (chat) => {
        chat.rename("Renamed");
        chat.setReplyRule(ALICE, RULE);
      }),
    ).toThrow(ChatRefusal);
    expect(row("feishu", "oc_group")).toMatchObject({
      sourceThreadName: null,
      channelSettings: null,
    });
  });

  it("keeps the others the platform reports, and Rome's accounts as its rows", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);

    chats.update(GROUP, (chat) =>
      chat.setParticipants([
        { account: SALES, romes: true },
        { account: ALICE, romes: false },
      ]),
    );

    expect(row("feishu", "oc_group")?.participants).toEqual({ others: [ALICE] });
    expect(chats.byKey(GROUP)?.participants).toEqual([
      { account: SALES, romes: true },
      { account: ALICE, romes: false },
    ]);
  });

  it("gives one of Rome's accounts that joins a row of its own", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);

    chats.update(GROUP, (chat) =>
      chat.setParticipants([
        { account: SALES, romes: true },
        { account: SUPPORT, romes: true },
      ]),
    );

    expect(row("feishu-2", "oc_group")).toMatchObject({ sourceChannel: "feishu-2" });
  });

  it("takes the chat's rows and messages when the last of Rome's accounts leaves", async () => {
    chats.startIfMissing(GROUP, "group", SALES, null);
    const id = channelChatId("feishu", "oc_group");
    testDb.db
      .insert(romeAgentMessages)
      .values({ id: "m1", sessionId: id, role: "user", content: "hi", createdAt: new Date() })
      .run();

    chats.update(GROUP, (chat) => chat.setParticipants([{ account: ALICE, romes: false }]));

    expect(chats.byKey(GROUP)).toBeNull();
    expect(
      testDb.db.select().from(romeAgentMessages).where(eq(romeAgentMessages.sessionId, id)).all(),
    ).toEqual([]);
  });

  it("keeps what was said through one of Rome's accounts that leaves a live chat", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);
    chats.startIfMissing(GROUP, "group", SUPPORT, null);
    const id = channelChatId("feishu", "oc_group");
    testDb.db
      .insert(romeAgentMessages)
      .values({ id: "m1", sessionId: id, role: "user", content: "hi", createdAt: new Date() })
      .run();

    chats.update(GROUP, (chat) => chat.setParticipants([{ account: SUPPORT, romes: true }]));

    expect(chats.byKey(GROUP)?.participants).toEqual([{ account: SUPPORT, romes: true }]);
    expect(row("feishu", "oc_group")?.participants).toEqual({ others: [], left: true });
    expect(
      testDb.db.select().from(romeAgentMessages).where(eq(romeAgentMessages.sessionId, id)).all(),
    ).toHaveLength(1);

    const back = chats.startIfMissing(GROUP, "group", SALES, null);
    expect(back.isRomes(SALES)).toBe(true);
    expect(row("feishu", "oc_group")?.participants).toBeNull();
  });

  it("reads the same peer id on two of Rome's accounts as two direct messages", () => {
    const peer = chatKey("feishu", "ou_alice" as ChatId);
    chats.startIfMissing(peer, "dm", SALES, "Alice");
    chats.startIfMissing(peer, "dm", SUPPORT, "Alice");

    chats.update(peer, (chat) => chat.setReplyRule(SALES, RULE), SALES);

    expect(chats.byKey(peer, SALES)?.participants).toEqual([{ account: SALES, romes: true }]);
    expect(chats.byKey(peer, SUPPORT)?.replyRule).toBeNull();
    expect(row("feishu-2", "ou_alice")?.channelSettings).toBeNull();
    expect(() => chats.byKey(peer)).toThrow("name the account");
  });

  it("never joins a row of unknown type to another account's chat", () => {
    chats.startIfMissing(GROUP, "group", SALES, null, { threadType: null });
    chats.startIfMissing(GROUP, "group", SUPPORT, null, { threadType: null });

    expect(chats.byKey(GROUP, SALES)?.participants).toEqual([{ account: SALES, romes: true }]);
    expect(chats.byKey(GROUP, SUPPORT)?.participants).toEqual([{ account: SUPPORT, romes: true }]);
  });

  it("stands a channel no record holds for an account by its own name", () => {
    const via = chats.accountOn("telegram");
    expect(via).toEqual({ platform: "telegram", id: "telegram" });

    chats.startIfMissing(chatKey("telegram", "-100" as ChatId), "dm", via, null);

    expect(row("telegram", "-100")).toMatchObject({ sourceThreadType: "private" });
  });

  it("refuses to start through an account Rome does not hold", () => {
    expect(() => chats.startIfMissing(GROUP, "group", ALICE, null)).toThrow(ChatRefusal);
  });

  it("finds a chat's rows through the chat id index", () => {
    const query = testDb.db
      .select()
      .from(romeSessions)
      .where(
        and(
          isChannelConversation,
          eq(romeSessions.sourceThreadId, "oc_group"),
          isNull(romeSessions.parentSessionId),
        ),
      )
      .toSQL();
    const client = (testDb.db as unknown as { $client: Database.Database }).$client;
    const plan = client.prepare(`explain query plan ${query.sql}`).all(...query.params);

    expect(JSON.stringify(plan)).toContain("idx_rome_sessions_chat_id");
  });

  it("reads no thread row as a chat", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);
    testDb.db
      .update(romeSessions)
      .set({ parentSessionId: "some-parent" })
      .where(eq(romeSessions.id, channelChatId("feishu", "oc_group")))
      .run();

    expect(chats.byKey(GROUP)).toBeNull();
  });
});
