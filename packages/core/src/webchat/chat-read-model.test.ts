import { beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { chatKey, ownedBy } from "../connections/chat-ids.js";
import type { ChatRef } from "../chats/storage/place.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { channels, romeAgentMessages, romeSessions } from "../db/schema.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { seatFixture } from "../test/seats.js";
import { ChatReadModel, type Transcript, type TranscriptCursor } from "./chat-read-model.js";

const text = (content: string) => JSON.stringify([{ type: "text", content }]);

describe("ChatReadModel", () => {
  let testDb: TestDb;
  let repo: WebChatRepository;
  let reads: ChatReadModel;
  let links: TurnLinks;
  let fixture: ReturnType<typeof seatFixture>;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new WebChatRepository(testDb.db);
    reads = new ChatReadModel(testDb.db);
    links = new TurnLinks(testDb.db);
    fixture = seatFixture(testDb.db);
  });

  /** A dashboard chat, and the agent's seat in it, opened under `id`. */
  function dashboardChat(id: string, name = "Chat"): ChatRef {
    const chat = fixture.chat("webchat", id, "dm", name);
    fixture.seat({ id, chat, accountId: "guardian", createdAt: new Date(0) });
    return chat;
  }

  async function traceAt(sessionId: string, id: string, turnId: string, seconds: number) {
    await repo.appendTraceBlocks({
      messageId: id,
      sessionId,
      turnId,
      startSeq: 0,
      blocks: [{ type: "turn_end", turnId, status: "completed", durationMs: 1 }],
    });
    await testDb.db
      .update(romeAgentMessages)
      .set({ createdAt: new Date(seconds * 1000) })
      .where(sql`${romeAgentMessages.id} = ${id}`);
  }

  /** The guardian's question and the agent's answer in turn `index`. */
  async function dashboardTurn(chat: ChatRef, sessionId: string, index: number, at: number) {
    const turnId = `turn-${index}`;
    const asked = fixture.say({
      id: `u-${index}`,
      chat,
      from: "guardian",
      text: `question ${index}`,
      at: new Date(at * 1000),
    });
    links.prompt(asked, sessionId, turnId);
    await traceAt(sessionId, `t-${index}`, turnId, at + 1);
    const answered = fixture.say({
      id: `a-${index}`,
      chat,
      from: "agent:main",
      agent: "main",
      text: `answer ${index}`,
      at: new Date((at + 2) * 1000),
    });
    links.answer(answered, sessionId, turnId);
  }

  describe("chatTranscript", () => {
    it("draws a dashboard chat, each line with its turn and sender, and each turn's trace", async () => {
      const chat = dashboardChat("chat-1");
      await dashboardTurn(chat, "chat-1", 0, 1_000);
      await dashboardTurn(chat, "chat-1", 1, 2_000);

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

    it("pages newest turns first and walks back to the start once", async () => {
      const chat = dashboardChat("chat-1");
      for (let index = 0; index < 5; index += 1) {
        await dashboardTurn(chat, "chat-1", index, 1_000 + index * 10);
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
      const key = chatKey("feishu", "oc_launch" as ChatId);
      const chat = fixture.chat(key.platform, key.externalId, "group", "Launch");
      const sales = "channel:sales:oc_launch";
      const support = "channel:support:oc_launch";
      fixture.seat({ id: sales, chat, accountId: "bot-sales", agentName: "sales" });
      fixture.seat({ id: support, chat, accountId: "bot-support", agentName: "support" });
      // Wei's question reaches both bots: one line in the chat.
      const asked = fixture.say({
        id: ownedBy(key, "bot-sales", "om_1"),
        chat,
        from: "ou_wei",
        name: "Wei",
        text: "When does the price change?",
        at: now,
      });
      links.prompt(asked, sales, "sales-turn-7");
      await traceAt(sales, "sales-trace-7", "sales-turn-7", now.getTime() / 1000);
      const answered = fixture.say({
        id: ownedBy(key, "bot-sales", "om_2"),
        chat,
        from: "bot-sales",
        agent: "sales",
        text: "On the first of next month.",
        at: now,
      });
      links.answer(answered, sales, "sales-turn-7");

      const fromSales = await reads.chatTranscript(sales);
      const fromSupport = await reads.chatTranscript(support);

      expect(
        fromSales?.lines.map((line) => [
          line.role,
          line.sessionId,
          line.turnId,
          line.senderAccountId,
        ]),
      ).toEqual([
        ["user", sales, "sales-turn-7", "ou_wei"],
        ["assistant", sales, "sales-turn-7", "bot-sales"],
      ]);
      expect(fromSales?.traces.map((trace) => trace.id)).toEqual(["sales-trace-7"]);
      // Either seat opens the same place.
      expect(fromSupport?.lines.map((line) => line.id)).toEqual(
        fromSales?.lines.map((line) => line.id),
      );
    });

    it("pages whole turns even when two agents' turns interleave, and shows each once", async () => {
      const chat = fixture.chat("telegram", "-1001234567890123", "group");
      fixture.seat({ id: "sales", chat, accountId: "bot-sales" });
      fixture.seat({ id: "support", chat, accountId: "bot-support" });
      const line = (id: string, seconds: number, agent?: string) =>
        fixture.say({
          id,
          chat,
          from: agent ? `bot-${agent}` : "wei",
          agent: agent ?? null,
          at: new Date(seconds * 1000),
        });
      links.prompt(line("prompt-a", 1_000), "sales", "turn-a");
      links.prompt(line("prompt-b", 1_001), "support", "turn-b");
      links.answer(line("answer-a", 1_002, "sales"), "sales", "turn-a");
      links.answer(line("answer-b", 1_003, "support"), "support", "turn-b");

      const newest = await reads.chatTranscript("sales", { limit: 1 });
      expect(newest?.lines.map((l) => l.id)).toEqual(["prompt-b", "answer-b"]);
      const older = await reads.chatTranscript("sales", {
        limit: 1,
        before: newest?.nextCursor ?? null,
      });
      expect(older?.lines.map((l) => l.id)).toEqual(["prompt-a", "answer-a"]);
      expect(older?.nextCursor).toBeNull();
    });

    it("shows the trace of every turn a shown line prompted, also one drawn under another's", async () => {
      const chat = fixture.chat("telegram", "-1001234567890123", "group");
      fixture.seat({ id: "sales", chat, accountId: "bot-sales" });
      fixture.seat({ id: "support", chat, accountId: "bot-support" });
      const asked = fixture.say({ id: "q", chat, from: "wei", at: new Date(1_000_000) });
      links.prompt(asked, "sales", "turn-s");
      links.prompt(asked, "support", "turn-p");
      await traceAt("sales", "trace-s", "turn-s", 1_001);
      // Support's turn ended without a word in the chat.
      await traceAt("support", "trace-p", "turn-p", 1_002);

      const transcript = await reads.chatTranscript("sales");

      expect(transcript?.lines.map((l) => [l.id, l.turnId])).toEqual([["q", "turn-s"]]);
      expect(transcript?.traces.map((trace) => trace.id)).toEqual(["trace-s", "trace-p"]);
    });

    it("draws a line each of Rome's accounts holds a copy of once, with every copy's turn traced", async () => {
      const chat = fixture.chat("telegram", "-42", "group");
      fixture.seat({ id: "sales", chat, accountId: "bot-sales" });
      fixture.seat({ id: "support", chat, accountId: "bot-support" });
      const heard = (id: string, seconds: number) =>
        fixture.say({ id, chat, from: "wei", text: "hi", at: new Date(seconds * 1000) });
      heard("bot-sales:4", 999);
      heard("bot-support:8", 999);
      const mine = heard("bot-sales:5", 1_000);
      const theirs = heard("bot-support:9", 1_000);
      links.prompt(theirs, "support", "turn-p");
      links.prompt(mine, "sales", "turn-s");
      await traceAt("sales", "trace-s", "turn-s", 1_001);
      await traceAt("support", "trace-p", "turn-p", 1_002);
      links.answer(
        fixture.say({
          id: "bot-sales:6",
          chat,
          from: "bot-sales",
          agent: "main",
          at: new Date(1_003_000),
        }),
        "sales",
        "turn-s",
      );

      const whole = await reads.chatTranscript("sales");
      expect(whole?.lines.map((l) => [l.id, l.turnId])).toEqual([
        ["bot-sales:4", null],
        ["bot-sales:5", "turn-s"],
        ["bot-sales:6", "turn-s"],
      ]);
      expect(whole?.traces.map((trace) => trace.id)).toEqual(["trace-s", "trace-p"]);

      const newest = await reads.chatTranscript("sales", { limit: 1 });
      expect(newest?.lines.map((l) => l.id)).toEqual(["bot-sales:5", "bot-sales:6"]);
      expect(newest?.traces.map((trace) => trace.id)).toEqual(["trace-s", "trace-p"]);
      const older = await reads.chatTranscript("sales", {
        limit: 1,
        before: newest?.nextCursor ?? null,
      });
      expect(older?.lines.map((l) => l.id)).toEqual(["bot-sales:4"]);
      expect(older?.nextCursor).toBeNull();
    });

    it("draws a copy queued as a prompt over a copy no turn took", async () => {
      const chat = fixture.chat("telegram", "-42", "group");
      fixture.seat({ id: "sales", chat, accountId: "bot-sales" });
      fixture.seat({ id: "support", chat, accountId: "bot-support" });
      const heard = (id: string) =>
        fixture.say({ id, chat, from: "wei", text: "hi", at: new Date(1_000_000) });
      heard("bot-sales:5");
      links.prompt(heard("bot-support:9"), "support", null, "queued");

      const expected = [["bot-support:9", "user", "queued"]];
      const draw = (transcript: Awaited<ReturnType<typeof reads.chatTranscript>>) =>
        transcript?.lines.map((l) => [l.id, l.role, l.inputState]);
      expect(draw(await reads.chatTranscript("sales"))).toEqual(expected);
      expect(draw(await reads.chatTranscript("sales", { limit: 5 }))).toEqual(expected);
    });

    it("pages a turn by the lines it draws, not a copy it leaves to another turn", async () => {
      const chat = fixture.chat("telegram", "-42", "group");
      fixture.seat({ id: "sales", chat, accountId: "bot-sales" });
      fixture.seat({ id: "support", chat, accountId: "bot-support" });
      const heard = (id: string, seconds: number, text: string) =>
        fixture.say({ id, chat, from: "wei", text, at: new Date(seconds * 1000) });
      links.prompt(heard("bot-sales:1", 1_000, "earlier"), "sales", "turn-s");
      const theirs = heard("bot-support:2", 1_010, "hi");
      const mine = heard("bot-sales:3", 1_010, "hi");
      links.prompt(theirs, "support", "turn-p");
      links.prompt(mine, "sales", "turn-s");

      const whole = await reads.chatTranscript("sales");
      expect(whole?.lines.map((l) => [l.id, l.turnId])).toEqual([
        ["bot-sales:1", "turn-s"],
        ["bot-support:2", "turn-p"],
      ]);

      const newest = await reads.chatTranscript("sales", { limit: 1 });
      expect(newest?.lines.map((l) => l.id)).toEqual(["bot-support:2"]);
      const older = await reads.chatTranscript("sales", {
        limit: 1,
        before: newest?.nextCursor ?? null,
      });
      expect(older?.lines.map((l) => l.id)).toEqual(["bot-sales:1"]);
      expect(older?.nextCursor).toBeNull();
    });

    it("draws a line no turn took as a notification, and leaves out what was said before the seat", async () => {
      const chat = fixture.chat("telegram", "-1001234567890123", "group");
      fixture.seat({
        id: "seat-1",
        chat,
        accountId: "rome_bot",
        createdAt: new Date(1_000_000),
      });
      fixture.say({ id: "before", chat, from: "alice", at: new Date(999_000) });
      fixture.say({ id: "aside", chat, from: "alice", at: new Date(1_001_000) });

      const transcript = await reads.chatTranscript("seat-1");

      expect(transcript?.lines.map((line) => [line.id, line.role, line.sessionId])).toEqual([
        ["aside", "notification", "seat-1"],
      ]);
    });
  });

  describe("sessionTranscript", () => {
    async function setAt(id: string, seconds: number) {
      await testDb.db
        .update(romeAgentMessages)
        .set({ createdAt: new Date(seconds * 1000) })
        .where(sql`${romeAgentMessages.id} = ${id}`);
    }

    async function subagentTurn(index: number, at: number) {
      const turnId = `sub-turn-${index}`;
      await repo.addMessage(`sp-${index}`, "sub-1", "user", text(`task ${index}`), turnId);
      await traceAt("sub-1", `st-${index}`, turnId, at + 1);
      await repo.addMessage(`sa-${index}`, "sub-1", "assistant", text(`result ${index}`), turnId);
      await setAt(`sp-${index}`, at);
      await setAt(`sa-${index}`, at + 2);
    }

    it("draws a subagent's turns from its own prompt, answer and trace, paged by turn", async () => {
      await repo.ensureRomeSession({ id: "sub-1", name: "Sub", type: "subagent" } as never);
      for (let index = 0; index < 3; index += 1) await subagentTurn(index, 1_000 + index * 10);

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

  it("keeps the state of a session's own input", async () => {
    await repo.ensureRomeSession({ id: "fork-1", name: "Fork", type: "subagent" } as never);
    await repo.addMessage("fp-1", "fork-1", "user", text("try again"), "fork-turn-1");
    await testDb.db
      .update(romeAgentMessages)
      .set({ inputState: "queued" })
      .where(sql`${romeAgentMessages.id} = 'fp-1'`);

    const transcript = await reads.sessionTranscript("fork-1");

    expect(transcript.lines.map((line) => [line.id, line.inputState])).toEqual([
      ["fp-1", "queued"],
    ]);
  });

  describe("search", () => {
    it("finds one line per dashboard chat, the most recent match, with a snippet", async () => {
      const one = dashboardChat("chat-1", "One");
      const two = dashboardChat("chat-2", "Two");
      const asked = fixture.say({
        id: "m-1",
        chat: one,
        from: "guardian",
        text: "the launch plan draft",
        at: new Date(1_000_000),
      });
      links.prompt(asked, "chat-1", "t1");
      fixture.say({
        id: "m-2",
        chat: one,
        from: "agent:main",
        agent: "main",
        text: "Launch plan is ready",
        at: new Date(1_001_000),
      });
      fixture.say({ id: "m-3", chat: two, from: "guardian", text: "nothing here", at: new Date() });

      const hits = await reads.search("LAUNCH plan", 10);

      expect(hits.map((hit) => [hit.chatId, hit.messageId, hit.role, hit.snippet])).toEqual([
        ["chat-1", "m-2", "assistant", "Launch plan is ready"],
      ]);
    });

    it("finds a line only for a seat whose transcript draws it", async () => {
      const chat = fixture.chat("webchat", "chat-3", "group", "Three");
      fixture.seat({ id: "open", chat, accountId: "guardian", createdAt: new Date(0) });
      fixture.seat({
        id: "topic",
        chat,
        accountId: "guardian",
        threadId: "topic-1",
        createdAt: new Date(0),
      });
      fixture.seat({ id: "late", chat, accountId: "agent:late", createdAt: new Date(2_000_000) });
      fixture.say({
        id: "m-1",
        chat,
        from: "guardian",
        text: "plan alpha",
        at: new Date(1_000_000),
      });

      const hits = await reads.search("alpha", 10);

      expect(hits.map((hit) => hit.chatId)).toEqual(["open"]);
      expect((await reads.chatTranscript("open"))?.lines.map((l) => l.id)).toEqual(["m-1"]);
    });
  });

  describe("unreadCount", () => {
    it("counts lines from Rome after the read mark, up to the cap", async () => {
      const chat = dashboardChat("chat-1");
      await testDb.db
        .update(romeSessions)
        .set({ lastSeenActivityAt: new Date(1_000_000) })
        .where(sql`${romeSessions.id} = 'chat-1'`);
      for (const [id, fromRome, at] of [
        ["old", true, 900],
        ["mine", false, 2_000],
        ["new-1", true, 2_001],
        ["new-2", true, 2_002],
      ] as const) {
        fixture.say({
          id,
          chat,
          from: fromRome ? "agent:main" : "guardian",
          agent: fromRome ? "main" : null,
          at: new Date(at * 1000),
        });
      }

      expect(await reads.unreadCount("chat-1", 10)).toBe(2);
      expect(await reads.unreadCount("chat-1", 1)).toBe(1);
    });

    it("counts a line from Rome each of Rome's accounts holds a copy of once", async () => {
      const chat = fixture.chat("telegram", "-42", "group");
      fixture.seat({
        id: "sales",
        chat,
        accountId: "bot-sales",
        lastSeenActivityAt: new Date(1_000_000),
      });
      const said = (id: string, seconds: number) =>
        fixture.say({
          id,
          chat,
          from: "bot-sales",
          agent: "main",
          text: `reply ${seconds}`,
          at: new Date(seconds * 1000),
        });
      said("bot-sales:5", 2_000);
      said("bot-support:9", 2_000);
      said("bot-sales:6", 2_001);

      expect(await reads.unreadCount("sales", 10)).toBe(2);
      expect(await reads.unreadCount("sales", 1)).toBe(1);
    });
  });
});
