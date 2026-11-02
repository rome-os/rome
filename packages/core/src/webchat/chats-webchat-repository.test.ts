import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { chatMessages, chats, romeAgentMessages, romeSessions } from "../db/schema.js";
import { type Message, type RecordedMessage } from "../chats/storage/message.js";
import { MessageRepository, type Sent } from "../chats/storage/message-repository.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";

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
  });

  it("pages a chat's transcript by turn", async () => {
    await repo.createSession("chat-1", "Plans");
    await repo.addMessage("in-1", "chat-1", "user", text("One"), "turn-1");
    await repo.addMessage("out-1", "chat-1", "assistant", text("1"), "turn-1");
    await repo.addMessage("in-2", "chat-1", "user", text("Two"), "turn-2");
    await repo.addMessage("out-2", "chat-1", "assistant", text("2"), "turn-2");

    const page = await repo.getMessagesPage("chat-1", { limit: 1 });
    expect(page.rows.map((line) => line.id)).toEqual(["in-2", "out-2"]);
    expect(page.nextCursor).not.toBeNull();
    const older = await repo.getMessagesPage("chat-1", { limit: 1, before: page.nextCursor });
    expect(older.rows.map((line) => line.id)).toEqual(["in-1", "out-1"]);
    expect(older.nextCursor).toBeNull();
  });

  it("keeps the lines of a session in no chat as its own", async () => {
    await repo.ensureRomeSession({ id: "fork-1", type: "fork", name: "Fork", agentName: null });
    await repo.addMessage("in-1", "fork-1", "user", text("Hi"), "turn-1");

    expect(session("fork-1")?.chatId).toBeNull();
    expect(testDb.db.select().from(chatMessages).all()).toHaveLength(0);
    expect((await repo.getMessages("fork-1")).map((line) => line.id)).toEqual(["in-1"]);
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

  it("refuses an answer it could not record", async () => {
    class Unrecorded extends MessageRepository {
      override async send(): Promise<Sent> {
        return { id: null, key: "lost", recorded: false, at: new Date() };
      }
    }
    const unrecorded = new ChatsWebChatRepository(testDb.db, {
      links,
      lines: new Unrecorded(testDb.db),
    });
    await unrecorded.createSession("chat-1", "Plans");

    await expect(unrecorded.addBackendReplyMessage("chat-1", "turn-1", "Hello")).rejects.toThrow(
      "could not be recorded",
    );
  });
});
