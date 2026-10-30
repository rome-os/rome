import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "@rstest/core";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { channels, romeAgentMessages, romeSessions } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatReadModel } from "./chat-read-model.js";

const text = (content: string) => JSON.stringify([{ type: "text", content }]);

describe("ChatReadModel", () => {
  let testDb: TestDb;
  let repo: WebChatRepository;
  let reads: ChatReadModel;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new WebChatRepository(testDb.db);
    reads = new ChatReadModel(testDb.db);
  });

  async function setSaidAt(id: string, seconds: number) {
    await testDb.db
      .update(romeAgentMessages)
      .set({ createdAt: new Date(seconds * 1000) })
      .where(sql`${romeAgentMessages.id} = ${id}`);
  }

  async function seedDashboardTurn(sessionId: string, index: number, at: number) {
    const turnId = `turn-${index}`;
    await repo.addMessage(`u-${index}`, sessionId, "user", text(`question ${index}`), turnId);
    await repo.appendTraceBlocks({
      messageId: `t-${index}`,
      sessionId,
      turnId,
      startSeq: 0,
      blocks: [{ type: "turn_end", turnId, status: "completed", durationMs: 1 }],
    });
    await repo.addMessage(`a-${index}`, sessionId, "assistant", text(`answer ${index}`), turnId);
    await setSaidAt(`u-${index}`, at);
    await setSaidAt(`t-${index}`, at + 1);
    await setSaidAt(`a-${index}`, at + 2);
  }

  describe("transcript", () => {
    it("draws a dashboard chat by turn, prompt then answer, with the sender", async () => {
      await repo.createSession("chat-1", "Chat");
      await seedDashboardTurn("chat-1", 0, 1_000);
      await seedDashboardTurn("chat-1", 1, 2_000);

      const transcript = await reads.transcript("chat-1");

      expect(
        transcript?.lines.map((line) => [line.id, line.role, line.turnId, line.senderAccountId]),
      ).toEqual([
        ["u-0", "user", "turn-0", "guardian"],
        ["a-0", "assistant", "turn-0", "agent:main"],
        ["u-1", "user", "turn-1", "guardian"],
        ["a-1", "assistant", "turn-1", "agent:main"],
      ]);
      expect(transcript?.nextCursor).toBeNull();
    });

    it("pages newest turns first and walks back to the start once", async () => {
      await repo.createSession("chat-1", "Chat");
      for (let index = 0; index < 5; index += 1) {
        await seedDashboardTurn("chat-1", index, 1_000 + index * 10);
      }

      const seen: string[] = [];
      let before: { startedAt: number; key: string } | null = null;
      for (;;) {
        const page = await reads.transcript("chat-1", { limit: 2, before });
        seen.unshift(...(page?.lines.map((line) => line.id) ?? []));
        if (!page?.nextCursor) break;
        before = page.nextCursor;
      }

      expect(seen).toEqual([0, 1, 2, 3, 4].flatMap((index) => [`u-${index}`, `a-${index}`]));
    });

    it("is null for a session that is no chat", async () => {
      await repo.ensureRomeSession({ id: "handoff-1", name: "Handoff", type: "handoff" } as never);

      expect(await reads.transcript("handoff-1")).toBeNull();
    });

    it("shows a group two of Rome's agents are in once, each turn under its own agent", async () => {
      const now = new Date();
      await testDb.db.insert(channels).values([
        {
          id: "sales",
          connectionKind: "feishu",
          platform: "feishu",
          platformAccountId: "bot-sales",
          createdAt: now,
        },
        {
          id: "support",
          connectionKind: "feishu",
          platform: "feishu",
          platformAccountId: "bot-support",
          createdAt: now,
        },
      ]);
      const sales = await repo.ensureChannelChat({
        channel: "sales",
        threadId: "oc_launch",
        threadType: "group",
        threadName: "Launch",
        agentName: "sales",
      });
      const support = await repo.ensureChannelChat({
        channel: "support",
        threadId: "oc_launch",
        threadType: "group",
        threadName: "Launch",
        agentName: "support",
      });
      // Wei's question reaches both bots: one line in the chat.
      for (const seat of [sales.id, support.id]) {
        await repo.addConversationMessage({
          sessionId: seat,
          role: "notification",
          content: text("When does the price change?"),
          platformMessageId: "om_1",
          senderId: "ou_wei",
          senderName: "Wei",
        });
      }
      await repo.promoteConversationMessageToUser(sales.id, "om_1");
      await repo.assignConversationMessageTurn(sales.id, "om_1", "sales-turn-7");
      await repo.appendTraceBlocks({
        messageId: "sales-trace-7",
        sessionId: sales.id,
        turnId: "sales-turn-7",
        startSeq: 0,
        blocks: [{ type: "turn_end", turnId: "sales-turn-7", status: "completed", durationMs: 1 }],
      });
      await repo.recordOutboundConversationMessage({
        sessionId: sales.id,
        content: text("On the first of next month."),
        platformMessageId: "om_2",
        turnId: "sales-turn-7",
        knownToProvider: true,
      });

      const rows = await testDb.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM chats`);
      expect(rows[0]?.n).toBe(1);
      const fromSales = await reads.transcript(sales.id);
      const fromSupport = await reads.transcript(support.id);

      const drawn = fromSales?.lines.map((line) => [
        line.role,
        line.sessionId,
        line.turnId,
        line.senderAccountId,
      ]);
      expect(drawn).toEqual([
        ["user", sales.id, "sales-turn-7", "ou_wei"],
        ["assistant", sales.id, "sales-turn-7", "bot-sales"],
      ]);
      // Either seat opens the same place.
      expect(fromSupport?.lines.map((line) => line.id)).toEqual(
        fromSales?.lines.map((line) => line.id),
      );
    });
  });

  describe("turnTraces", () => {
    it("reads the traces of the named turns only, each under its own session", async () => {
      await repo.createSession("chat-1", "Chat");
      await seedDashboardTurn("chat-1", 0, 1_000);
      await seedDashboardTurn("chat-1", 1, 2_000);

      const traces = await reads.turnTraces([
        { sessionId: "chat-1", turnId: "turn-1" },
        { sessionId: "other-session", turnId: "turn-0" },
      ]);

      expect(traces.map((trace) => [trace.id, trace.sessionId, trace.turnId])).toEqual([
        ["t-1", "chat-1", "turn-1"],
      ]);
    });
  });

  describe("search", () => {
    it("finds one line per dashboard chat, the most recent match, with a snippet", async () => {
      await repo.createSession("chat-1", "One");
      await repo.createSession("chat-2", "Two");
      await repo.addMessage("m-1", "chat-1", "user", text("the launch plan draft"), "t1");
      await repo.addMessage("m-2", "chat-1", "assistant", text("Launch plan is ready"), "t1");
      await repo.addMessage("m-3", "chat-2", "user", text("nothing here"), "t2");
      await setSaidAt("m-1", 1_000);
      await setSaidAt("m-2", 1_001);

      const hits = await reads.search("LAUNCH plan", 10);

      expect(hits.map((hit) => [hit.chatId, hit.messageId, hit.role, hit.snippet])).toEqual([
        ["chat-1", "m-2", "assistant", "Launch plan is ready"],
      ]);
    });
  });

  describe("unreadCount", () => {
    it("counts lines from Rome after the read mark, up to the cap", async () => {
      await repo.createSession("chat-1", "Chat");
      await testDb.db
        .update(romeSessions)
        .set({ lastSeenActivityAt: new Date(1_000_000) })
        .where(sql`${romeSessions.id} = 'chat-1'`);
      for (const [id, role, at] of [
        ["old", "assistant", 900],
        ["mine", "user", 2_000],
        ["new-1", "assistant", 2_001],
        ["new-2", "assistant", 2_002],
      ] as const) {
        await repo.addMessage(id, "chat-1", role, text(id), "t");
        await setSaidAt(id, at);
      }

      expect(await reads.unreadCount("chat-1", 10)).toBe(2);
      expect(await reads.unreadCount("chat-1", 1)).toBe(1);
    });
  });
});

describe("0103_chats_tables backfill", () => {
  const migration = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system/0103_chats_tables.sql"),
    "utf8",
  );
  const statements = migration.split("--> statement-breakpoint").map((part) => part.trim());
  const backfill = statements.filter(
    (statement) =>
      /^(INSERT OR IGNORE INTO|UPDATE `rome_sessions`)/m.test(statement) &&
      !statement.includes("CREATE TRIGGER"),
  );

  it("collapses a group two of Rome's accounts are in, keeps ids, and links turns", async () => {
    const testDb = createTestDb();
    const sqlite = (testDb.db as unknown as { $client: import("better-sqlite3").Database }).$client;
    // Today's rows as they stood before the migration: no mirror, no chat ids.
    for (const { name } of sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_mirror_%'")
      .all() as { name: string }[]) {
      sqlite.exec(`DROP TRIGGER "${name}"`);
    }
    sqlite.exec(`
      INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
        VALUES ('sales', 'feishu', 'feishu', 'bot-sales', 1), ('support', 'feishu', 'feishu', 'bot-support', 1);
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type,
        source_thread_name, agent_name, created_at, activity_at)
      VALUES
        ('channel:sales:oc_launch', 'Launch', 'channel', 'sales', 'oc_launch', 'group', 'Launch', 'sales', 10, 10),
        ('channel:support:oc_launch', 'Launch', 'channel', 'support', 'oc_launch', 'group', 'Launch', 'support', 20, 20),
        ('chat-1', 'Dashboard', 'channel', 'webchat', 'chat-1', NULL, NULL, NULL, 30, 30);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id,
        sender_id, sender_name, context_injected_turn_id, actor, created_at)
      VALUES
        ('wei-sales', 'channel:sales:oc_launch', 'turn-7', 'user', '[{"type":"text","content":"When?"}]', 'om_1', 'ou_wei', 'Wei', NULL, NULL, 100),
        ('wei-support', 'channel:support:oc_launch', NULL, 'notification', '[{"type":"text","content":"When?"}]', 'om_1', 'ou_wei', 'Wei', 'turn-3', NULL, 100),
        ('reply', 'channel:sales:oc_launch', 'turn-7', 'assistant', '[{"type":"text","content":"Soon."}]', 'om_2', NULL, NULL, NULL, NULL, 101),
        ('trace-7', 'channel:sales:oc_launch', 'turn-7', 'trace', '[]', NULL, NULL, NULL, NULL, NULL, 100),
        ('ask', 'chat-1', 'turn-1', 'user', '[{"type":"text","content":"hi"}]', NULL, NULL, NULL, NULL,
          '{"kind":"visitor","accountId":"acct-ada","email":"ada@example.com"}', 200);
    `);

    for (const statement of backfill) sqlite.exec(statement);

    expect(
      sqlite
        .prepare("SELECT id, platform, platform_chat_id, kind, name FROM chats ORDER BY id")
        .all(),
    ).toEqual([
      {
        id: "channel:sales:oc_launch",
        platform: "feishu",
        platform_chat_id: "oc_launch",
        kind: "group",
        name: "Launch",
      },
      {
        id: "chat-1",
        platform: "webchat",
        platform_chat_id: "chat-1",
        kind: "dm",
        name: "Dashboard",
      },
    ]);
    expect(sqlite.prepare("SELECT id, chat_id FROM rome_sessions ORDER BY id").all()).toEqual([
      { id: "channel:sales:oc_launch", chat_id: "channel:sales:oc_launch" },
      { id: "channel:support:oc_launch", chat_id: "channel:sales:oc_launch" },
      { id: "chat-1", chat_id: "chat-1" },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT id, sender_account_id, sender_agent, sender_name, text FROM chat_messages ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "ask",
        sender_account_id: "visitor:acct-ada",
        sender_agent: null,
        sender_name: "ada@example.com",
        text: "hi",
      },
      {
        id: "reply",
        sender_account_id: "bot-sales",
        sender_agent: "sales",
        sender_name: null,
        text: "Soon.",
      },
      {
        id: "wei-sales",
        sender_account_id: "ou_wei",
        sender_agent: null,
        sender_name: "Wei",
        text: "When?",
      },
    ]);
    expect(sqlite.prepare("SELECT message_id, state FROM chat_message_deliveries").all()).toEqual([
      { message_id: "reply", state: "sent" },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT message_id, session_id, turn_id, role FROM agent_turn_messages ORDER BY session_id, message_id",
        )
        .all(),
    ).toEqual([
      {
        message_id: "reply",
        session_id: "channel:sales:oc_launch",
        turn_id: "turn-7",
        role: "answer",
      },
      {
        message_id: "wei-sales",
        session_id: "channel:sales:oc_launch",
        turn_id: "turn-7",
        role: "prompt",
      },
      {
        message_id: "wei-sales",
        session_id: "channel:support:oc_launch",
        turn_id: "turn-3",
        role: "seen",
      },
      { message_id: "ask", session_id: "chat-1", turn_id: "turn-1", role: "prompt" },
    ]);
  });
});
