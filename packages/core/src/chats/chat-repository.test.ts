import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Account, ChatId, StoredChatSettings } from "@rome-os/app-runtime";
import { eq } from "drizzle-orm";
import { romeAgentMessages, romeSessions, sessions } from "../db/schema.js";
import { channelChatId } from "../db/session-kind.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, createTestDbFile, type TestDb } from "../test/helpers.js";
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

  it("keeps Rome's accounts as its rows and no one else, over today's rows", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);

    chats.update(GROUP, (chat) =>
      chat.setParticipants([
        { account: SALES, romes: true },
        { account: ALICE, romes: false },
      ]),
    );

    expect(chats.byKey(GROUP)?.participants).toEqual([{ account: SALES, romes: true }]);
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

  it("completes the agent sessions of an ended chat, so starting it again resumes none", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);
    const now = new Date();
    const session = (id: string, values: { channelThreadKey?: string; chatId?: string }) => ({
      id,
      agentName: "main",
      status: "active" as const,
      createdAt: now,
      lastActiveAt: now,
      ...values,
    });
    testDb.db
      .insert(sessions)
      .values([
        session("by-key", { channelThreadKey: "feishu:oc_group" }),
        session("by-chat", { chatId: channelChatId("feishu", "oc_group") }),
        session("elsewhere", { channelThreadKey: "feishu:oc_other" }),
      ])
      .run();

    chats.update(GROUP, (chat) => chat.end());
    chats.startIfMissing(GROUP, "group", SALES, null);

    const status = (id: string) =>
      testDb.db.select().from(sessions).where(eq(sessions.id, id)).get()?.status;
    expect(status("by-key")).toBe("completed");
    expect(status("by-chat")).toBe("completed");
    expect(status("elsewhere")).toBe("active");
  });

  it("refuses one of Rome's accounts leaving a live chat, and keeps its row", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);
    chats.startIfMissing(GROUP, "group", SUPPORT, null);

    expect(() =>
      chats.update(GROUP, (chat) => chat.setParticipants([{ account: SUPPORT, romes: true }])),
    ).toThrow(ChatRefusal);
    expect(row("feishu", "oc_group")).toBeDefined();
    expect(chats.byKey(GROUP)?.participants).toHaveLength(2);
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

  it("never joins a row of unknown type or a direct message to a group", () => {
    chats.startIfMissing(GROUP, "group", SALES, null, { threadType: null });
    chats.startIfMissing(GROUP, "group", SUPPORT, null, { threadType: null });

    expect(chats.byKey(GROUP, SALES)?.participants).toEqual([{ account: SALES, romes: true }]);
    expect(chats.byKey(GROUP, SUPPORT)?.participants).toEqual([{ account: SUPPORT, romes: true }]);
  });

  it("starts a chat of its own for an untyped or private row beside a typed group", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);
    chats.update(GROUP, (chat) => chat.setReplyRule(SALES, RULE));

    chats.startIfMissing(GROUP, "group", SUPPORT, null, { threadType: null });

    expect(row("feishu-2", "oc_group")).toMatchObject({
      sourceThreadType: null,
      channelSettings: null,
    });
    expect(chats.byKey(GROUP, SUPPORT)?.participants).toEqual([{ account: SUPPORT, romes: true }]);
    expect(chats.byKey(GROUP, SALES)?.participants).toEqual([{ account: SALES, romes: true }]);

    const dm = chatKey("feishu", "ou_alice" as ChatId);
    chats.startIfMissing(dm, "group", SALES, null);
    chats.startIfMissing(dm, "dm", SUPPORT, null);
    expect(row("feishu-2", "ou_alice")).toMatchObject({ sourceThreadType: "private" });
    expect(chats.byKey(dm, SALES)?.participants).toHaveLength(1);
  });

  it("joins a row stored with no type to the group once a message names its type", () => {
    chats.startIfMissing(GROUP, "group", SUPPORT, null, { threadType: null });
    chats.startIfMissing(GROUP, "group", SALES, null);
    chats.update(GROUP, (chat) => chat.setReplyRule(SALES, RULE), SALES);

    chats.startIfMissing(GROUP, "group", SUPPORT, null, { threadType: "group" });

    expect(row("feishu-2", "oc_group")).toMatchObject({
      sourceThreadType: "group",
      channelSettings: RULE,
    });
    expect(chats.byKey(GROUP)?.participants).toHaveLength(2);

    const dm = chatKey("feishu", "ou_alice" as ChatId);
    chats.startIfMissing(dm, "dm", SUPPORT, null, { threadType: null });
    chats.startIfMissing(dm, "dm", SUPPORT, null, { threadType: "private" });
    expect(row("feishu-2", "ou_alice")?.sourceThreadType).toBeNull();
  });

  it("reads an untyped row with the group when asked to", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);
    chats.update(GROUP, (chat) => chat.setReplyRule(SALES, RULE));
    chats.startIfMissing(GROUP, "group", SUPPORT, null, { threadType: null });

    expect(chats.byKey(GROUP, SUPPORT, true)?.replyRule).toEqual(RULE);
    expect(chats.byKey(GROUP, SUPPORT)?.replyRule).toBeNull();
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

  it("reads no thread row as a chat", () => {
    chats.startIfMissing(GROUP, "group", SALES, null);
    testDb.db
      .update(romeSessions)
      .set({ parentSessionId: "some-parent" })
      .where(eq(romeSessions.id, channelChatId("feishu", "oc_group")))
      .run();

    expect(chats.byKey(GROUP)).toBeNull();
  });

  it("takes the write lock before it reads, so another connection's commit fails no join", () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-repository-"));
    const open = createTestDbFile(join(dir, "rome.db"));
    const main = open();
    const worker = open();
    worker.sqlite.pragma("busy_timeout = 0");
    try {
      new ChatRepository(main.db, channels).startIfMissing(GROUP, "group", SALES, null);
      let otherWrite: unknown = null;
      // Reached after the join has read the group's rows and before it writes.
      const racing: ChatChannels = {
        ...channels,
        accountOf: (name) => {
          if (otherWrite === null) {
            try {
              worker.db
                .update(romeSessions)
                .set({ name: "elsewhere" })
                .where(eq(romeSessions.id, channelChatId("feishu", "oc_group")))
                .run();
              otherWrite = "committed";
            } catch (err) {
              otherWrite = err;
            }
          }
          return channels.accountOf(name);
        },
      };

      new ChatRepository(main.db, racing).startIfMissing(GROUP, "group", SUPPORT, null);

      expect(String(otherWrite)).toContain("database is locked");
      expect(new ChatRepository(main.db, channels).byKey(GROUP)?.participants).toHaveLength(2);
    } finally {
      main.close();
      worker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
