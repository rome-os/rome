import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "@rstest/core";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { channels, chatMessages, romeAgentMessages, romeSessions } from "../db/schema.js";
import { chatAt, lineAt } from "../chats/adapter.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { seatFixture } from "../test/seats.js";
import { ChatReadModel, type Transcript, type TranscriptCursor } from "./chat-read-model.js";

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
    // A seat's lines are Chats', and a seat sees what was said since it joined.
    await testDb.db
      .update(chatMessages)
      .set({ saidAt: new Date(seconds * 1000) })
      .where(sql`${chatMessages.id} = ${id}`);
    await testDb.db.run(sql`UPDATE rome_sessions SET created_at = min(created_at, ${seconds})`);
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

  describe("chatTranscript", () => {
    it("draws a dashboard chat, each line with its turn and sender, and each turn's trace", async () => {
      await repo.createSession("chat-1", "Chat");
      await seedDashboardTurn("chat-1", 0, 1_000);
      await seedDashboardTurn("chat-1", 1, 2_000);

      const transcript = await reads.chatTranscript("chat-1");

      expect(
        transcript?.lines.map((line) => [line.id, line.role, line.turnId, line.senderAccountId]),
      ).toEqual([
        ["u-0", "user", "turn-0", "guardian"],
        ["a-0", "assistant", "turn-0", "agent:main"],
        ["u-1", "user", "turn-1", "guardian"],
        ["a-1", "assistant", "turn-1", "agent:main"],
      ]);
      expect(transcript?.traces.map((trace) => [trace.id, trace.turnId])).toEqual([
        ["t-0", "turn-0"],
        ["t-1", "turn-1"],
      ]);
      expect(transcript?.nextCursor).toBeNull();
    });

    it("pages newest messages first and walks back to the start once", async () => {
      await repo.createSession("chat-1", "Chat");
      for (let index = 0; index < 5; index += 1) {
        await seedDashboardTurn("chat-1", index, 1_000 + index * 10);
      }

      const seen: string[] = [];
      let before: TranscriptCursor | null = null;
      for (;;) {
        const page: Transcript | null = await reads.chatTranscript("chat-1", { limit: 3, before });
        seen.unshift(...(page?.lines.map((line) => line.id) ?? []));
        if (!page?.nextCursor) break;
        before = page.nextCursor;
      }

      expect(seen).toEqual([0, 1, 2, 3, 4].flatMap((index) => [`u-${index}`, `a-${index}`]));
    });

    it("is null for a session that stands in no chat", async () => {
      await repo.ensureRomeSession({ id: "handoff-1", name: "Handoff", type: "handoff" } as never);

      expect(await reads.chatTranscript("handoff-1")).toBeNull();
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
      const fixture = seatFixture(testDb.db);
      const chat = chatAt("feishu", "oc_launch");
      fixture.chat(chat.platform, chat.id, "group", "Launch");
      const sales = { id: "channel:sales:oc_launch" };
      const support = { id: "channel:support:oc_launch" };
      fixture.seat({ id: sales.id, chat, accountId: "bot-sales", agentName: "sales" });
      fixture.seat({ id: support.id, chat, accountId: "bot-support", agentName: "support" });
      // Wei's question reaches both bots: one line in the chat.
      const asked = lineAt(chat, "bot-sales", "om_1");
      fixture.say({
        id: asked,
        chat,
        from: "ou_wei",
        name: "Wei",
        text: "When does the price change?",
        at: new Date(),
      });
      const links = new TurnLinks(testDb.db);
      links.prompt(asked, sales.id, "sales-turn-7");
      await repo.appendTraceBlocks({
        messageId: "sales-trace-7",
        sessionId: sales.id,
        turnId: "sales-turn-7",
        startSeq: 0,
        blocks: [{ type: "turn_end", turnId: "sales-turn-7", status: "completed", durationMs: 1 }],
      });
      const answered = lineAt(chat, "bot-sales", "om_2");
      fixture.say({
        id: answered,
        chat,
        from: "bot-sales",
        agent: "sales",
        text: "On the first of next month.",
        at: new Date(),
      });
      links.answer(answered, sales.id, "sales-turn-7");

      const rows = await testDb.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM chats`);
      expect(rows[0]?.n).toBe(1);
      const fromSales = await reads.chatTranscript(sales.id);
      const fromSupport = await reads.chatTranscript(support.id);

      expect(
        fromSales?.lines.map((line) => [
          line.role,
          line.sessionId,
          line.turnId,
          line.senderAccountId,
        ]),
      ).toEqual([
        ["user", sales.id, "sales-turn-7", "ou_wei"],
        ["assistant", sales.id, "sales-turn-7", "bot-sales"],
      ]);
      expect(fromSales?.traces.map((trace) => trace.id)).toEqual(["sales-trace-7"]);
      // Either seat opens the same place.
      expect(fromSupport?.lines.map((line) => line.id)).toEqual(
        fromSales?.lines.map((line) => line.id),
      );
    });
  });

  describe("sessionTranscript", () => {
    async function seedSubagentTurn(index: number, at: number) {
      const turnId = `sub-turn-${index}`;
      await repo.addMessage(`sp-${index}`, "sub-1", "user", text(`task ${index}`), turnId);
      await repo.appendTraceBlocks({
        messageId: `st-${index}`,
        sessionId: "sub-1",
        turnId,
        startSeq: 0,
        blocks: [{ type: "turn_end", turnId, status: "completed", durationMs: 1 }],
      });
      await repo.addMessage(`sa-${index}`, "sub-1", "assistant", text(`result ${index}`), turnId);
      await setSaidAt(`sp-${index}`, at);
      await setSaidAt(`st-${index}`, at + 1);
      await setSaidAt(`sa-${index}`, at + 2);
    }

    it("draws a subagent's turns from its own prompt, answer and trace, paged by turn", async () => {
      await repo.ensureRomeSession({ id: "sub-1", name: "Sub", type: "subagent" } as never);
      for (let index = 0; index < 3; index += 1) await seedSubagentTurn(index, 1_000 + index * 10);

      const newest = await reads.sessionTranscript("sub-1", { limit: 2 });
      expect(newest.lines.map((line) => [line.id, line.role])).toEqual([
        ["sp-1", "user"],
        ["sa-1", "assistant"],
        ["sp-2", "user"],
        ["sa-2", "assistant"],
      ]);
      expect(newest.traces.map((trace) => trace.id)).toEqual(["st-1", "st-2"]);

      const older = await reads.sessionTranscript("sub-1", {
        limit: 2,
        before: newest.nextCursor,
      });
      expect(older.lines.map((line) => line.id)).toEqual(["sp-0", "sa-0"]);
      expect(older.nextCursor).toBeNull();
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
