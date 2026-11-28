import type { ChatId } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq, sql, type SQL } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { chatKey } from "../chats/storage/place.js";
import { chatMessages, chats, romeAgentMessages, romeSessions } from "../db/schema.js";
import { type Message, type RecordedMessage } from "../chats/storage/message.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository, sessionLines } from "./chats-webchat-repository.js";

// The dashboard's repository over Chats' tables. What these pin: a dashboard
// chat is a webchat DM keyed by its session, its user and assistant lines are
// Chats' lines linked to their turns and read back as the transcript, a
// session's traces stay its own, and a session in no chat keeps its own lines.

const text = (content: string) => JSON.stringify([{ type: "text", content }]);

describe("ChatsWebChatRepository", () => {
  let testDb: TestDb;
  let repo: ChatsWebChatRepository;
  let links: TurnLinks;

  beforeEach(() => {
    testDb = createTestDb();
    links = new TurnLinks(testDb.db);
    repo = new ChatsWebChatRepository(testDb.db, { links });
  });
  afterEach(() => testDb.close());

  const session = (id: string) =>
    testDb.db.select().from(romeSessions).where(eq(romeSessions.id, id)).get();
  const ownRows = (id: string) =>
    testDb.db.select().from(romeAgentMessages).where(eq(romeAgentMessages.sessionId, id)).all();

  it.each([
    "automated::1::agent:core:main",
    "automated::1::app:daily-report",
    "automated::0::agent:coding:coding",
    "automated::0::app:daily-report",
    "automated::0::routine:Morning briefing",
    "automated::0::unknown",
    "core:concierge",
    "visitor:assistant",
    "automated:assistant",
  ])("keeps source %s separate from ownership and reads it for replies", async (senderId) => {
    await repo.createSession("source-chat", "Sources");
    const actor = { kind: "guardian" as const, userId: "seat", via: "loopback" as const };
    expect(
      await repo.recordUserInput("source-input", "source-chat", "[]", actor, {
        platform: "webchat",
        id: senderId,
      }),
    ).toBe(true);
    expect(await repo.getUserMessageSources("source-chat")).toEqual(
      new Map([["source-input", senderId]]),
    );
    expect(await repo.getUserMessageSources("source-chat", ["source-input"])).toEqual(
      new Map([["source-input", senderId]]),
    );
    expect((await repo.getUserMessageSources("source-chat", ["other"])).size).toBe(0);
    expect((await repo.getReplyTarget("source-chat", "source-input"))?.senderId).toBe(senderId);
    expect((await repo.getMessagesPage("source-chat", { limit: 1 })).rows[0]).toMatchObject({
      id: "source-input",
      role: "user",
    });
    await repo.updateUserInput("source-chat", {
      type: "input_status",
      inputId: "source-input",
      turnId: "source-turn",
      state: "accepted",
    });
    expect(await repo.getTurnChatMessages("source-chat", "source-turn")).toMatchObject([
      { id: "source-input", role: "user", senderId },
    ]);
    expect(await repo.getUserInput("source-chat", "source-input")).toMatchObject({
      turnId: "source-turn",
      inputState: "accepted",
    });
    if (senderId.startsWith("automated::")) {
      expect((await repo.getUserMessageActors("source-chat")).get("source-input")?.kind).toBe(
        "guardian",
      );
    }
    expect(await repo.getReplyTarget("another-chat", "source-input")).toBeNull();
    expect(await repo.getSessionOwnerKey("source-chat")).toBeNull();
    const line = testDb.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.key, "source-input"))
      .get();
    expect(line?.senderAccountId).toBe(
      senderId.startsWith("automated::")
        ? senderId
        : senderId === "core:concierge"
          ? "guardian"
          : `agent:${senderId}`,
    );
    expect(line?.senderAgent).toBe(senderId.startsWith("automated::") ? null : senderId);
    await repo.recordUserInput("old-loopback", "source-chat", "[]", actor);
    expect((await repo.getUserMessageSources("source-chat")).has("old-loopback")).toBe(false);
    expect((await repo.getUserMessageActors("source-chat")).get("old-loopback")?.kind).toBe(
      "guardian",
    );
  });
  it.each([
    "user",
    "trace",
  ])("reads a session's %s lines by the session, not by every session's rows of that role", (role) => {
    const plan = testDb.db
      .all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT * FROM ${sessionLines(["chat-1"])} WHERE role = ${role}`,
      )
      .map((row) => row.detail);
    expect(plan.some((detail) => detail.includes("idx_rome_agent_messages_role_created_at"))).toBe(
      false,
    );
  });
  it("starts a webchat chat for a new session, keyed by the session", async () => {
    await repo.createSession("chat-1", "Plans", undefined, undefined, null, null, "writer");

    const row = session("chat-1");
    const chat = testDb.db
      .select()
      .from(chats)
      .where(eq(chats.id, row?.chatId ?? -1))
      .get();
    expect(chat?.platform).toBe("webchat");
    expect(chat?.key).toBe("chat-1");
    expect(chat?.kind).toBe("dm");
    expect(row?.accountId).toBe("agent:writer");
  });

  it("says a turn's prompt and answer in the chat and reads them back as its transcript", async () => {
    await repo.createSession("chat-1", "Plans");
    expect(await repo.recordUserInput("in-1", "chat-1", text("Hi"))).toBe(true);
    expect(await repo.getUserInput("chat-1", "in-1")).toEqual({
      turnId: null,
      inputState: "queued",
    });
    await repo.updateUserInput("chat-1", {
      type: "input_status",
      inputId: "in-1",
      turnId: "turn-1",
      state: "accepted",
    });
    await repo.addMessage("out-1", "chat-1", "assistant", text("Hello"), "turn-1");
    await repo.addMessage("trace-1", "chat-1", "trace", "[]", "turn-1");

    expect(testDb.db.select().from(chatMessages).all()).toHaveLength(2);
    expect(ownRows("chat-1").map((row) => row.role)).toEqual(["trace"]);
    const transcript = await repo.getMessages("chat-1");
    expect(transcript.map((line) => [line.id, line.role, line.turnId])).toEqual([
      ["in-1", "user", "turn-1"],
      ["trace-1", "trace", "turn-1"],
      ["out-1", "assistant", "turn-1"],
    ]);
    expect(transcript[0]?.inputState).toBe("accepted");
    expect(await repo.getUserInput("chat-1", "in-1")).toEqual({
      turnId: "turn-1",
      inputState: "accepted",
    });
    expect(await repo.getMessageCount("chat-1")).toBe(3);
    expect(await repo.hasTurnInSession("chat-1", "turn-1")).toBe(true);
    expect(
      (await repo.getTurnChatMessages("chat-1", "turn-1")).map((line) => [line.id, line.role]),
    ).toEqual([
      ["in-1", "user"],
      ["out-1", "assistant"],
    ]);
    expect((await repo.getReplyTarget("chat-1", "out-1"))?.role).toBe("assistant");
    expect((await repo.getUserMessageActors("chat-1")).get("in-1")?.kind).toBe("guardian");
    expect((await repo.getUserMessageActors("chat-1", ["other"])).size).toBe(0);
    expect((await repo.getUserMessageActors("chat-1", ["in-1"])).size).toBe(1);
  });

  it("pages a chat's transcript by message, newest first, with each page's turns' traces", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.addMessage("in-1", "chat-1", "user", text("One"), "turn-1");
    await repo.addMessage("trace-1", "chat-1", "trace", "[]", "turn-1");
    await repo.addMessage("out-1", "chat-1", "assistant", text("1"), "turn-1");
    await repo.addMessage("in-2", "chat-1", "user", text("Two"), "turn-2");
    await repo.addMessage("trace-2", "chat-1", "trace", "[]", "turn-2");
    await repo.addMessage("out-2", "chat-1", "assistant", text("2"), "turn-2");

    // The traces of the turns a page's messages belong to come along, and do not count.
    const page = await repo.getMessagesPage("chat-1", { limit: 2 });
    expect(page.rows.map((line) => line.id)).toEqual(["in-2", "trace-2", "out-2"]);
    expect(page.nextCursor).not.toBeNull();
    const older = await repo.getMessagesPage("chat-1", { limit: 2, before: page.nextCursor });
    expect(older.rows.map((line) => line.id)).toEqual(["in-1", "trace-1", "out-1"]);
    expect(older.nextCursor).toBeNull();
  });

  it("pages in the order messages were said when two turns interleave, and splits no message", async () => {
    await repo.createSession("chat-1", "Plans");
    rs.useFakeTimers({ toFake: ["Date"] });
    try {
      const say = async (
        seconds: number,
        id: string,
        role: "user" | "assistant" | "trace",
        turn: string,
      ) => {
        rs.setSystemTime(new Date(1_800_000_000_000 + seconds * 1_000));
        await repo.addMessage(id, "chat-1", role, role === "trace" ? "[]" : text(id), turn);
      };
      // Owner-A, owner-B queued behind A's turn, answer-A, answer-B.
      await say(0, "owner-a", "user", "turn-a");
      await say(1, "owner-b", "user", "turn-b");
      await say(2, "trace-a", "trace", "turn-a");
      await say(3, "answer-a", "assistant", "turn-a");
      await say(4, "answer-b", "assistant", "turn-b");
    } finally {
      rs.useRealTimers();
    }

    expect((await repo.getMessages("chat-1")).map((line) => line.id)).toEqual([
      "owner-a",
      "owner-b",
      "trace-a",
      "answer-a",
      "answer-b",
    ]);
    const newest = await repo.getMessagesPage("chat-1", { limit: 2 });
    // A's trace is older than both answers, so it stands right after the oldest message.
    expect(newest.rows.map((line) => line.id)).toEqual(["answer-a", "trace-a", "answer-b"]);
    const older = await repo.getMessagesPage("chat-1", { limit: 2, before: newest.nextCursor });
    expect(older.rows.map((line) => line.id)).toEqual(["owner-a", "owner-b", "trace-a"]);
    expect(older.nextCursor).toBeNull();
  });

  it("keeps messages said in the same second in the order they were recorded, on every page", async () => {
    await repo.createSession("chat-1", "Plans");
    rs.useFakeTimers({ toFake: ["Date"] });
    try {
      rs.setSystemTime(new Date(1_800_000_000_000));
      // Ids that sort against the order recorded in, all in one second.
      for (const id of ["m-z", "m-a", "m-m", "m-b"]) {
        await repo.addMessage(id, "chat-1", "assistant", text(id));
      }
    } finally {
      rs.useRealTimers();
    }
    const ids = (rows: { id: string }[]) => rows.map((line) => line.id);
    expect(ids(await repo.getMessages("chat-1"))).toEqual(["m-z", "m-a", "m-m", "m-b"]);
    const newest = await repo.getMessagesPage("chat-1", { limit: 2 });
    expect(ids(newest.rows)).toEqual(["m-m", "m-b"]);
    const older = await repo.getMessagesPage("chat-1", { limit: 2, before: newest.nextCursor });
    expect(ids(older.rows)).toEqual(["m-z", "m-a"]);
    expect(older.nextCursor).toBeNull();
  });

  it("reaches an old message in one page, with older messages for context", async () => {
    await repo.createSession("chat-1", "Plans");
    for (let turn = 1; turn <= 8; turn++) {
      await repo.addMessage(`in-${turn}`, "chat-1", "user", text(`Q${turn}`), `turn-${turn}`);
      await repo.addMessage(`out-${turn}`, "chat-1", "assistant", text(`A${turn}`), `turn-${turn}`);
    }
    const idsOf = (rows: { id: string }[]) => rows.map((line) => line.id);

    const all = idsOf(await repo.getMessages("chat-1"));

    // From out-5 to the newest are 7 messages, and 5 older ones come with them.
    const page = await repo.getMessagesPage("chat-1", { limit: 1, through: "out-5" });
    expect(idsOf(page.rows)).toEqual(all.slice(4));
    expect(page.nextCursor).not.toBeNull();

    // From the oldest page held, it brings only what lies between.
    const newest = await repo.getMessagesPage("chat-1", { limit: 2 });
    const between = await repo.getMessagesPage("chat-1", {
      limit: 1,
      before: newest.nextCursor,
      through: "in-4",
    });
    expect(idsOf(between.rows)).toEqual(all.slice(1, 14));

    // A message the chat does not hold pages as usual.
    const plain = await repo.getMessagesPage("chat-1", { limit: 1, through: "elsewhere" });
    expect(idsOf(plain.rows)).toEqual(["out-8"]);
  });

  // A subagent, fork or action run stands in no chat, so its prompts and
  // answers are its own.
  it("keeps the lines of a session in no chat as its own", async () => {
    await repo.ensureRomeSession({ id: "fork-1", type: "fork", name: "Fork", agentName: null });
    await repo.addMessage("in-1", "fork-1", "user", text("Hi"), "turn-1");

    expect(session("fork-1")?.chatId).toBeNull();
    expect(testDb.db.select().from(chatMessages).all()).toHaveLength(0);
    expect((await repo.getMessages("fork-1")).map((line) => line.id)).toEqual(["in-1"]);
    expect(await repo.getMessageCount("fork-1")).toBe(1);
  });

  it("moves a promoted fork's lines into its new chat, linked to their turns", async () => {
    await repo.ensureRomeSession({ id: "fork-1", type: "fork", name: "Fork", agentName: null });
    await repo.addMessage("in-1", "fork-1", "user", text("Hi"), "turn-1");
    await repo.addMessage("out-1", "fork-1", "assistant", text("Hello"), "turn-1");

    await repo.promoteForkToChat("fork-1");

    expect(session("fork-1")?.chatId).not.toBeNull();
    expect(ownRows("fork-1")).toHaveLength(0);
    expect(
      (await repo.getMessages("fork-1")).map((line) => [line.id, line.role, line.turnId]),
    ).toEqual([
      ["in-1", "user", "turn-1"],
      ["out-1", "assistant", "turn-1"],
    ]);
  });
  it("says the prompt and answer of a fork promoted while its turn runs in its chat", async () => {
    await repo.ensureRomeSession({ id: "fork-1", type: "fork", name: "Fork", agentName: null });
    await repo.promoteForkToChat("fork-1");
    await repo.appendTraceBlocks({
      messageId: "trace-1",
      sessionId: "fork-1",
      turnId: "turn-1",
      startSeq: 0,
      blocks: [{ type: "text", content: "thinking" }],
      transcriptMessages: [
        { id: "in-1", sessionId: "fork-1", turnId: "turn-1", role: "user", content: text("Hi") },
        {
          id: "out-1",
          sessionId: "fork-1",
          turnId: "turn-1",
          role: "assistant",
          content: text("Hello"),
        },
      ],
    });

    expect(ownRows("fork-1").map((row) => row.role)).toEqual(["trace"]);
    expect(
      (await repo.getMessages("fork-1")).map((line) => [line.id, line.role, line.turnId]),
    ).toEqual([
      ["in-1", "user", "turn-1"],
      ["trace-1", "trace", "turn-1"],
      ["out-1", "assistant", "turn-1"],
    ]);
  });

  it("leaves a fork whose promotion failed a fork, so promoting it again finishes", async () => {
    let failures = 1;
    class Failing extends MessageRepository {
      override record(message: Message): RecordedMessage | null {
        if (failures > 0) {
          failures -= 1;
          throw new Error("disk full");
        }
        return super.record(message);
      }
    }
    const failing = new ChatsWebChatRepository(testDb.db, {
      links,
      lines: new Failing(testDb.db),
    });
    await failing.ensureRomeSession({ id: "fork-1", type: "fork", name: "Fork", agentName: null });
    await failing.addMessage("in-1", "fork-1", "user", text("Hi"), "turn-1");

    await expect(failing.promoteForkToChat("fork-1")).rejects.toThrow("disk full");
    expect(session("fork-1")?.type).toBe("fork");
    expect(session("fork-1")?.chatId).toBeNull();
    expect(ownRows("fork-1")).toHaveLength(1);

    await failing.promoteForkToChat("fork-1");
    expect(session("fork-1")?.chatId).not.toBeNull();
    expect((await failing.getMessages("fork-1")).map((line) => line.id)).toEqual(["in-1"]);
  });

  it("refuses an answer it could not record, and emits nothing", async () => {
    class Failing extends MessageRepository {
      override record(): RecordedMessage | null {
        throw new Error("disk full");
      }
    }
    const failing = new ChatsWebChatRepository(testDb.db, {
      links,
      lines: new Failing(testDb.db),
    });
    await failing.createSession("chat-1", "Plans");
    const emitted: string[] = [];
    failing.onMessageInserted((message) => emitted.push(message.id));

    await expect(failing.addBackendReplyMessage("chat-1", "turn-1", "Hello")).rejects.toThrow(
      "disk full",
    );
    expect(emitted).toEqual([]);
  });

  it("writes nothing of a trace batch whose answer could not be said, so a retry finishes it", async () => {
    let failures = 1;
    class Failing extends MessageRepository {
      override record(message: Message): RecordedMessage | null {
        if (message.key === "out-1" && failures > 0) {
          failures -= 1;
          throw new Error("disk full");
        }
        return super.record(message);
      }
    }
    const failing = new ChatsWebChatRepository(testDb.db, {
      links,
      lines: new Failing(testDb.db),
    });
    await failing.createSession("chat-1", "Plans");
    const batch = {
      messageId: "trace-1",
      sessionId: "chat-1",
      turnId: "turn-1",
      startSeq: 0,
      blocks: [{ type: "text", content: "thinking" }],
      transcriptMessages: [
        {
          id: "in-1",
          sessionId: "chat-1",
          turnId: "turn-1",
          role: "user" as const,
          content: text("Hi"),
        },
        {
          id: "out-1",
          sessionId: "chat-1",
          turnId: "turn-1",
          role: "assistant" as const,
          content: text("Hello"),
        },
      ],
    };

    await expect(failing.appendTraceBlocks(batch)).rejects.toThrow("disk full");
    expect(ownRows("chat-1")).toEqual([]);
    expect(testDb.db.select().from(chatMessages).all()).toEqual([]);
    await failing.appendTraceBlocks(batch);
    expect(
      (await failing.getMessages("chat-1")).map((line) => [line.id, line.role, line.turnId]),
    ).toEqual([
      ["in-1", "user", "turn-1"],
      ["trace-1", "trace", "turn-1"],
      ["out-1", "assistant", "turn-1"],
    ]);
  });

  it("records an input with its queued link or not at all", async () => {
    let failures = 1;
    class Failing extends TurnLinks {
      override prompt(...args: Parameters<TurnLinks["prompt"]>): void {
        if (failures > 0) {
          failures -= 1;
          throw new Error("disk full");
        }
        super.prompt(...args);
      }
    }
    const failing = new ChatsWebChatRepository(testDb.db, { links: new Failing(testDb.db) });
    await failing.createSession("chat-1", "Plans");

    await expect(failing.recordUserInput("in-1", "chat-1", text("Hi"))).rejects.toThrow(
      "disk full",
    );
    expect(testDb.db.select().from(chatMessages).all()).toHaveLength(0);
    expect(await failing.recordUserInput("in-1", "chat-1", text("Hi"))).toBe(true);
    expect(await failing.getUserInput("chat-1", "in-1")).toEqual({
      turnId: null,
      inputState: "queued",
    });
  });

  it("reads a line a turn only caught up on by who said it", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.addMessage("out-0", "chat-1", "assistant", text("Reminder"));
    const roleOf = async () =>
      (await repo.getMessages("chat-1")).map((line) => [line.id, line.role, line.turnId]);
    expect(await roleOf()).toEqual([["out-0", "assistant", null]]);

    const line = testDb.db.select().from(chatMessages).get();
    links.seen([line?.id ?? -1], "chat-1", "turn-2");
    expect(await roleOf()).toEqual([["out-0", "assistant", null]]);
  });
  it("leaves a handoff outside Chats", async () => {
    await repo.createSession(
      "handoff-1",
      "Handoff",
      undefined,
      undefined,
      null,
      null,
      null,
      "webchat_handoff",
    );
    expect(session("handoff-1")?.chatId).toBeNull();
  });

  // A dashboard notice is not a message in Chats yet (#1672).
  it("leaves a dashboard notice out of its chat's transcript", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.addMessage("note-1", "chat-1", "notification", text("Reminder set"));

    expect(await repo.getMessages("chat-1")).toEqual([]);
    expect(await repo.getMessageCount("chat-1")).toBe(0);
  });
  it("reads a channel chat's notification once, from Chats, though its old row stays", async () => {
    const telegram = new ChatRepository(testDb.db).start(
      chatKey("telegram", "t-1" as ChatId),
      "dm",
      "Ana",
    );
    await repo.ensureRomeSession({
      id: "channel:telegram:t-1",
      type: "channel",
      name: "Ana",
      agentName: null,
    });
    // As the backfill leaves it: the line in Chats, and its old row kept.
    testDb.db
      .update(romeSessions)
      .set({ chatId: telegram.ref.id, chatPlatform: telegram.ref.platform, createdAt: new Date(0) })
      .where(eq(romeSessions.id, "channel:telegram:t-1"))
      .run();
    testDb.db
      .insert(romeAgentMessages)
      .values({
        id: "note-1",
        sessionId: "channel:telegram:t-1",
        role: "notification",
        content: text("Hi"),
        createdAt: new Date(),
      })
      .run();
    new MessageRepository(testDb.db).record({
      direction: "toRome",
      place: { chat: telegram.ref },
      saidBy: { account: { platform: "telegram", id: "ana" } },
      key: "5",
      body: { text: "Hi" },
      at: new Date(),
    });

    expect((await repo.getMessages("channel:telegram:t-1")).map((line) => line.id)).toEqual(["5"]);
  });

  // Each of Rome's accounts records its own copy (#1670), and every message
  // recorded in the place is a line.
  it("reads every account's copy of a message where each account holds one", async () => {
    // A Telegram basic group numbers its messages per member account.
    const group = new ChatRepository(testDb.db).start(
      chatKey("telegram", "-42" as ChatId),
      "group",
      "Family",
    );
    await repo.ensureRomeSession({
      id: "channel:tg-sales:-42",
      type: "channel",
      name: "Family",
      agentName: null,
    });
    testDb.db
      .update(romeSessions)
      .set({
        chatId: group.ref.id,
        chatPlatform: group.ref.platform,
        accountId: "111",
        createdAt: new Date(0),
      })
      .where(eq(romeSessions.id, "channel:tg-sales:-42"))
      .run();
    const messages = new MessageRepository(testDb.db);
    for (const key of ["111:5", "222:7"]) {
      messages.record({
        direction: "toRome",
        place: { chat: group.ref },
        saidBy: { account: { platform: "telegram", id: "ann" } },
        key,
        body: { text: "Yo" },
        at: new Date(1000),
      });
    }

    expect((await repo.getMessages("channel:tg-sales:-42")).map((line) => line.id)).toEqual([
      "111:5",
      "222:7",
    ]);
    expect(await repo.getMessageCount("channel:tg-sales:-42")).toBe(2);
  });

  it("reads a steered input after the card it answers, in the same turn", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.recordUserInput("in-1", "chat-1", text("Plan a trip"));
    await repo.updateUserInput("chat-1", {
      type: "input_status",
      inputId: "in-1",
      turnId: "turn-1",
      state: "accepted",
    });
    await repo.addMessage("card-1", "chat-1", "assistant", text("Which city?"), "turn-1");
    await repo.recordUserInput("in-2", "chat-1", text("Lisbon"));
    await repo.updateUserInput("chat-1", {
      type: "input_status",
      inputId: "in-2",
      turnId: "turn-1",
      state: "accepted",
    });

    expect((await repo.getMessages("chat-1")).map((line) => line.id)).toEqual([
      "in-1",
      "card-1",
      "in-2",
    ]);
  });

  it("counts what was said in a chat as its activity for trace retention", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.addMessage("trace-1", "chat-1", "trace", "[]", "turn-1");
    testDb.db
      .update(romeAgentMessages)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(romeAgentMessages.id, "trace-1"))
      .run();
    const cutoff = new Date("2026-06-01T00:00:00Z");
    expect(await repo.getTraceArchivedSessionIds(["chat-1"], cutoff)).toEqual(["chat-1"]);

    await repo.addMessage("in-1", "chat-1", "user", text("Back again"), "turn-2");
    expect(await repo.getTraceArchivedSessionIds(["chat-1"], cutoff)).toEqual([]);
  });
  it("reads a session in no chat in the order its rows were written", async () => {
    await repo.ensureRomeSession({ id: "fork-1", type: "fork", name: "Fork", agentName: null });
    await repo.addMessage("in-1", "fork-1", "user", text("Plan a trip"), "turn-1");
    await repo.addMessage("card-1", "fork-1", "assistant", text("Which city?"), "turn-1");
    await repo.addMessage("in-2", "fork-1", "user", text("Lisbon"), "turn-1");

    expect((await repo.getMessages("fork-1")).map((line) => line.id)).toEqual([
      "in-1",
      "card-1",
      "in-2",
    ]);
  });

  it("keeps a promoted fork's inputs where they stand, queued or run", async () => {
    await repo.ensureRomeSession({ id: "fork-1", type: "fork", name: "Fork", agentName: null });
    await repo.recordUserInput("in-1", "fork-1", text("Run"));
    await repo.updateUserInput("fork-1", {
      type: "input_status",
      inputId: "in-1",
      turnId: "turn-1",
      state: "accepted",
    });
    await repo.recordUserInput("in-2", "fork-1", text("Then this"));

    await repo.promoteForkToChat("fork-1");

    expect(await repo.getUserInput("fork-1", "in-1")).toEqual({
      turnId: "turn-1",
      inputState: "accepted",
    });
    expect(await repo.getUserInput("fork-1", "in-2")).toEqual({
      turnId: null,
      inputState: "queued",
    });
  });

  it("records an input an agent said into a chat as that agent's", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.recordUserInput("in-1", "chat-1", text("Status?"), undefined, {
      platform: "webchat",
      id: "concierge",
    });

    const line = testDb.db.select().from(chatMessages).get();
    expect(line?.senderAgent).toBe("concierge");
    expect(line?.senderAccountId).toBe("agent:concierge");

    await repo.updateUserInput("chat-1", {
      type: "input_status",
      inputId: "in-1",
      turnId: "turn-1",
      state: "accepted",
    });
    expect(await repo.getTurnChatMessages("chat-1", "turn-1")).toEqual([
      {
        id: "in-1",
        role: "user",
        content: text("Status?"),
        senderId: "concierge",
        inputState: "accepted",
      },
    ]);
  });

  it("reads an input still queued after the line said before it in the same second", async () => {
    rs.useFakeTimers();
    try {
      rs.setSystemTime(new Date("2030-01-01T12:00:00.100Z"));
      await repo.createSession("chat-1", "Plans");
      await repo.addMessage("out-0", "chat-1", "assistant", text("Reminder"));
      rs.setSystemTime(new Date("2030-01-01T12:00:00.500Z"));
      await repo.recordUserInput("in-1", "chat-1", text("Thanks"));

      expect((await repo.getMessages("chat-1")).map((line) => line.id)).toEqual(["out-0", "in-1"]);
    } finally {
      rs.useRealTimers();
    }
  });

  it("reads a trace batch's prompt, trace and answer in order across a second's edge", async () => {
    rs.useFakeTimers();
    try {
      rs.setSystemTime(new Date("2030-01-01T12:00:00.999Z"));
      await repo.createSession("chat-1", "Plans");
      await repo.appendTraceBlocks({
        messageId: "trace-1",
        sessionId: "chat-1",
        turnId: "turn-1",
        startSeq: 0,
        blocks: [{ type: "text", content: "thinking" }],
        transcriptMessages: [
          { id: "in-1", sessionId: "chat-1", turnId: "turn-1", role: "user", content: text("Hi") },
          {
            id: "out-1",
            sessionId: "chat-1",
            turnId: "turn-1",
            role: "assistant",
            content: text("Hello"),
          },
        ],
      });

      expect((await repo.getMessages("chat-1")).map((line) => line.id)).toEqual([
        "in-1",
        "trace-1",
        "out-1",
      ]);
    } finally {
      rs.useRealTimers();
    }
  });
  it("ends a deleted session's dashboard chat with every line said in it", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.createSession("chat-2", "Other");
    await repo.addMessage("in-1", "chat-1", "user", text("Hi"), "turn-1");
    await repo.addMessage("in-2", "chat-2", "user", text("Hey"), "turn-2");

    await repo.deleteSession("chat-1");

    expect(testDb.db.select({ key: chats.key }).from(chats).all()).toEqual([{ key: "chat-2" }]);
    expect(testDb.db.select({ key: chatMessages.key }).from(chatMessages).all()).toEqual([
      { key: "in-2" },
    ]);
  });

  it("ends the dashboard chats of a deleted project's sessions", async () => {
    await repo.createSession("chat-1", "Plans", undefined, "Trips", null, "/trips");
    await repo.createSession("chat-2", "Other", undefined, "Work", null, "/work");

    expect(await repo.deleteSessionsByProjectPathPrefix("/trips")).toBe(1);

    expect(testDb.db.select({ key: chats.key }).from(chats).all()).toEqual([{ key: "chat-2" }]);
  });

  it("leaves the channel chat a deleted session stood in", async () => {
    const telegram = new ChatRepository(testDb.db).start(
      chatKey("telegram", "t-1" as ChatId),
      "dm",
      "Ana",
    );
    await repo.ensureRomeSession({
      id: "channel:telegram:t-1",
      type: "channel",
      name: "Ana",
      agentName: null,
    });
    testDb.db
      .update(romeSessions)
      .set({ chatId: telegram.ref.id, chatPlatform: telegram.ref.platform })
      .where(eq(romeSessions.id, "channel:telegram:t-1"))
      .run();
    const heard = new MessageRepository(testDb.db).record({
      direction: "toRome",
      place: { chat: telegram.ref },
      saidBy: { account: { platform: "telegram", id: "ana" } },
      key: "5",
      body: { text: "Hi" },
      at: new Date(),
    })!;
    links.prompt(heard.id, "channel:telegram:t-1", "turn-1");

    await repo.deleteSession("channel:telegram:t-1");

    expect(testDb.db.select({ key: chats.key }).from(chats).all()).toEqual([{ key: "t-1" }]);
    expect(testDb.db.select({ key: chatMessages.key }).from(chatMessages).all()).toEqual([
      { key: "5" },
    ]);
    expect(links.linkOf("channel:telegram:t-1", heard.id)).toBeNull();
  });

  it("names a session's dashboard chat with it", async () => {
    await repo.createSession("chat-1", "Plans");
    const chatName = () => testDb.db.select({ name: chats.name }).from(chats).get()?.name;

    await repo.updateSessionName("chat-1", "Lisbon trip");
    expect(chatName()).toBe("Lisbon trip");

    expect(await repo.updateSessionNameIfCurrent("chat-1", "Plans", "Porto trip")).toBe(false);
    expect(chatName()).toBe("Lisbon trip");
    expect(await repo.updateSessionNameIfCurrent("chat-1", "Lisbon trip", "Porto trip")).toBe(true);
    expect(chatName()).toBe("Porto trip");
  });

  // The list, search and unread count read lines said only in Chats: nothing
  // below has a row in rome_agent_messages but its trace.
  it("lists a chat with its line count and a card that waits on the guardian", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.recordUserInput("in-1", "chat-1", text("Pick a date"));
    await repo.updateUserInput("chat-1", {
      type: "input_status",
      inputId: "in-1",
      turnId: "turn-1",
      state: "accepted",
    });
    await repo.addMessage(
      "out-1",
      "chat-1",
      "assistant",
      JSON.stringify([{ type: "pending_interaction", id: "q-1" }]),
      "turn-1",
    );
    await repo.addMessage("trace-1", "chat-1", "trace", "[]", "turn-1");

    const [listed] = await repo.listSessions();
    expect(listed).toMatchObject({ id: "chat-1", messageCount: 3, awaitingGuardian: true });
  });

  it("finds a chat by what was said in it", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.createSession("chat-2", "Other");
    await repo.addMessage("out-1", "chat-1", "assistant", text("The ferry leaves at noon"));
    await repo.addMessage("out-2", "chat-2", "assistant", text("Nothing about boats"));

    const matches = await repo.searchSessionMessages("ferry NOON");
    expect(
      matches.map((match) => [match.session.id, match.message.id, match.message.role]),
    ).toEqual([["chat-1", "out-1", "assistant"]]);
    expect(matches[0]?.message.snippet).toContain("ferry leaves at noon");
  });

  it("leaves a dashboard notice out of search, as out of the transcript", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.addMessage("note-1", "chat-1", "notification", text("Reminder set for the ferry"));

    expect(await repo.searchSessionMessages("ferry")).toEqual([]);
  });

  it("counts the lines from Rome since the chat was last read, up to a cap", async () => {
    rs.useFakeTimers();
    try {
      rs.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
      await repo.createSession("chat-1", "Plans");
      await repo.markSessionRead("chat-1");
      rs.setSystemTime(new Date("2029-01-01T00:00:01.000Z"));
      for (const id of ["out-1", "out-2", "out-3"]) {
        await repo.addMessage(id, "chat-1", "assistant", text(id));
      }

      expect(await repo.countUnreadAgentMessages("chat-1", 10)).toBe(3);
      expect(await repo.countUnreadAgentMessages("chat-1", 2)).toBe(2);
    } finally {
      rs.useRealTimers();
    }
  });

  describe("a page of a chat thread", () => {
    const START = 1_800_000_000;
    const at = (seconds: number) => rs.setSystemTime(new Date((START + seconds) * 1000));
    // A message of the owner that replies to `replyTo`, said `seconds` into the chat.
    const say = async (seconds: number, key: string, replyTo?: string) => {
      at(seconds);
      await repo.recordUserInput(key, "chat-1", text(key), undefined, undefined, replyTo);
    };
    const page = async (
      messageId: string,
      options: { limit: number; before?: string; after?: string },
    ) => {
      const result = await repo.getThreadPage("chat-1", messageId, options);
      if ("error" in result) throw new Error(result.error);
      return {
        ids: result.rows.map((line) => line.id),
        hasOlder: result.hasOlder,
        hasNewer: result.hasNewer,
      };
    };

    beforeEach(async () => {
      rs.useFakeTimers({ toFake: ["Date"] });
      at(-10);
      await repo.createSession("chat-1", "Plans");
      // m1 is the root of the chain, and x1 and x2 are in none.
      await say(0, "m1");
      await say(1, "x1");
      await say(2, "m2", "m1");
      await say(3, "m3", "m2");
      await say(4, "x2");
      await say(5, "m4", "m1");
      await say(6, "m5", "m4");
      await say(7, "m6", "m5");
    });
    afterEach(() => {
      rs.useRealTimers();
    });

    it("reads the chain around a message, up to the limit on each side", async () => {
      expect(await page("m4", { limit: 2 })).toEqual({
        ids: ["m2", "m3", "m4", "m5", "m6"],
        hasOlder: true,
        hasNewer: false,
      });
      // The chain's end exactly at the limit is no more.
      expect(await page("m4", { limit: 3 })).toMatchObject({ hasOlder: false, hasNewer: false });
      // The root, and a message in the chain of one.
      expect(await page("m1", { limit: 1 })).toEqual({
        ids: ["m1", "m2"],
        hasOlder: false,
        hasNewer: true,
      });
      expect(await page("x1", { limit: 5 })).toEqual({
        ids: ["x1"],
        hasOlder: false,
        hasNewer: false,
      });
      // Any message of the chain names the chain.
      expect((await page("m6", { limit: 10 })).ids).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    });

    it("reads the chain before a message, and after one, from the chain alone", async () => {
      expect(await page("m6", { limit: 2, before: "m4" })).toEqual({
        ids: ["m2", "m3"],
        hasOlder: true,
        hasNewer: true,
      });
      expect(await page("m6", { limit: 5, before: "m2" })).toEqual({
        ids: ["m1"],
        hasOlder: false,
        hasNewer: true,
      });
      expect(await page("m6", { limit: 5, before: "m1" })).toEqual({
        ids: [],
        hasOlder: false,
        hasNewer: true,
      });
      expect(await page("m1", { limit: 2, after: "m2" })).toEqual({
        ids: ["m3", "m4"],
        hasOlder: true,
        hasNewer: true,
      });
      expect(await page("m1", { limit: 2, after: "m5" })).toEqual({
        ids: ["m6"],
        hasOlder: true,
        hasNewer: false,
      });
      expect((await page("m1", { limit: 2, after: "m6" })).ids).toEqual([]);
    });

    it("steps through messages said in the same second, each once, in the order recorded", async () => {
      at(100);
      const said: [string, string?][] = [["s1"], ["s2", "s1"], ["s3", "s1"], ["s4", "s2"]];
      for (const [key, replyTo] of said) {
        await repo.recordUserInput(key, "chat-1", text(key), undefined, undefined, replyTo);
      }
      expect((await page("s3", { limit: 1 })).ids).toEqual(["s2", "s3", "s4"]);
      const forward: string[] = [];
      let id = (await page("s1", { limit: 1, after: "s1" })).ids[0];
      while (id) {
        forward.push(id);
        id = (await page("s1", { limit: 1, after: id })).ids[0];
      }
      expect(forward).toEqual(["s2", "s3", "s4"]);
      expect(await page("s1", { limit: 1, before: "s4" })).toMatchObject({
        ids: ["s3"],
        hasOlder: true,
      });
    });

    it("reads a chain from the root index and the root's row, not through the rest of the chat", async () => {
      const db = testDb.db as unknown as {
        dialect: { sqlToQuery(query: SQL): { sql: string; params: unknown[] } };
        $client: {
          prepare(sql: string): { all(...values: unknown[]): Array<{ detail: string }> };
        };
      };
      const all = rs.spyOn(testDb.db, "all");
      try {
        await page("m1", { limit: 2, after: "m4" });
        const plans = all.mock.calls
          .map(([query]) => db.dialect.sqlToQuery(query as SQL))
          .filter((query) => query.sql.includes(") chain"))
          .map((query) =>
            db.$client
              .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
              .all(...query.params)
              .map((row) => row.detail)
              .join("\n"),
          );
        expect(plans).toHaveLength(1);
        expect(plans[0]).toContain("idx_chat_messages_root");
        expect(plans[0]).toContain("INTEGER PRIMARY KEY");
        expect(plans[0]).not.toContain("idx_chat_messages_page");
      } finally {
        all.mockRestore();
      }
    });

    it("finds no message that is not the chat's, a trace, or one the session did not see, and refuses a cursor of another chain", async () => {
      const miss = (id: string, options: { before?: string; after?: string } = {}) =>
        repo.getThreadPage("chat-1", id, { limit: 5, ...options });
      expect(await miss("gone")).toEqual({ error: "message_not_found" });
      expect(await miss("m1", { before: "gone" })).toEqual({ error: "message_not_found" });
      expect(await miss("m4", { after: "x2" })).toEqual({ error: "not_in_thread" });
      expect(await miss("m4", { before: "x1" })).toEqual({ error: "not_in_thread" });
      await repo.addMessage("trace-1", "chat-1", "trace", "[]", "turn-1");
      expect(await miss("trace-1")).toEqual({ error: "message_not_found" });
      // A session in no chat has no chains.
      await repo.ensureRomeSession({ id: "fork-1", type: "fork", name: "Fork", agentName: null });
      await repo.addMessage("f1", "fork-1", "user", text("Hi"), "turn-9");
      expect(await repo.getThreadPage("fork-1", "f1", { limit: 5 })).toEqual({
        error: "message_not_found",
      });
      // A message said before the session started there is not the session's.
      testDb.db
        .update(chatMessages)
        .set({ saidAt: new Date(1000) })
        .where(eq(chatMessages.key, "m1"))
        .run();
      expect(await miss("m1")).toEqual({ error: "message_not_found" });
      expect(await page("m2", { limit: 5 })).toMatchObject({
        ids: ["m2", "m3", "m4", "m5", "m6"],
        hasOlder: false,
      });
    });

    it("brings the traces of the turns of the page's messages, placed as the main paging places them", async () => {
      const answer = async (seconds: number, turn: string) => {
        at(seconds);
        return (
          await repo.addBackendMessage("chat-1", turn, [{ type: "text", content: turn }], {
            replyTo: "m1",
          })
        ).id;
      };
      at(20);
      await repo.addMessage("trace-1", "chat-1", "trace", "[]", "turn-1");
      const a1 = await answer(21, "turn-1");
      at(22);
      await repo.addMessage("trace-2", "chat-1", "trace", "[]", "turn-2");
      const a2 = await answer(23, "turn-2");
      // A trace of a turn of a message that is not on the page does not come.
      expect((await page("m1", { limit: 1, after: "m6" })).ids).toEqual([a1, "trace-1"]);
      // Traces older than the oldest message stand right after it.
      expect((await page(a2, { limit: 1 })).ids).toEqual([a1, "trace-1", "trace-2", a2]);
    });
  });

  describe("chat threads", () => {
    beforeEach(async () => {
      await repo.createSession("chat-1", "Plans");
    });
    const rows = () =>
      testDb.db
        .select({
          key: chatMessages.key,
          id: chatMessages.id,
          replyTo: chatMessages.replyToMessageId,
          root: chatMessages.rootMessageId,
          parts: chatMessages.parts,
        })
        .from(chatMessages)
        .all();
    const row = (key: string) => rows().find((candidate) => candidate.key === key)!;
    const said = async (words: string, replyTo?: string) =>
      (
        await repo.addBackendMessage("chat-1", "turn-1", [{ type: "text", content: words }], {
          ...(replyTo ? { replyTo } : {}),
        })
      ).id;

    it("records the message an input replies to, and its root, with no quote of its own", async () => {
      await repo.recordUserInput("m1", "chat-1", text("Weather?"));
      expect(
        await repo.recordUserInput("m2", "chat-1", text("And Friday?"), undefined, undefined, "m1"),
      ).toBe(true);
      expect(row("m1")).toMatchObject({ replyTo: null, root: null });
      expect(row("m2")).toMatchObject({ replyTo: row("m1").id, root: row("m1").id });
      expect(JSON.parse(row("m2").parts)).toEqual([{ type: "text", content: "And Friday?" }]);
      // A reply to a reply joins the same thread, and a reply to nothing the chat holds is none.
      await repo.recordUserInput("m3", "chat-1", text("Thanks"), undefined, undefined, "m2");
      await repo.recordUserInput("m4", "chat-1", text("Hm"), undefined, undefined, "gone");
      expect(row("m3")).toMatchObject({ replyTo: row("m2").id, root: row("m1").id });
      expect(row("m4")).toMatchObject({ replyTo: null, root: null });
    });

    it("sets a backend message's reply and root, and adds no reply_to part", async () => {
      await repo.recordUserInput("m1", "chat-1", text("Weather?"));
      const answer = await said("Sunny", "m1");
      const alone = await said("Good morning");
      expect(row(answer)).toMatchObject({ replyTo: row("m1").id, root: row("m1").id });
      expect(JSON.parse(row(answer).parts)).toEqual([{ type: "text", content: "Sunny" }]);
      expect(row(alone)).toMatchObject({ replyTo: null, root: null });
    });

    it("reads each message with the key of its thread's root, the root itself with its own", async () => {
      await repo.recordUserInput("m1", "chat-1", text("Weather?"));
      const answer = await said("Sunny", "m1");
      const alone = await said("Good morning");
      const threads = new Map(
        (await repo.getMessages("chat-1")).map((message) => [message.id, message.chatThreadId]),
      );
      expect(threads).toEqual(
        new Map([
          ["m1", "m1"],
          [answer, "m1"],
          [alone, alone],
        ]),
      );
      expect((await repo.getReplyTarget("chat-1", answer))?.chatThreadId).toBe("m1");
    });

    it("tells a message's thread when it is inserted", async () => {
      await repo.recordUserInput("m1", "chat-1", text("Weather?"));
      const inserted: (string | null | undefined)[] = [];
      repo.onMessageInserted((message) => inserted.push(message.chatThreadId));
      await said("Sunny", "m1");
      await said("Good morning");
      expect(inserted).toEqual(["m1", expect.any(String)]);
    });
  });
});
