import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { romeAgentMessages } from "../schema.js";
import { WebChatRepository } from "./webchat.js";
import { ConciergeTasksRepository } from "./concierge-tasks.js";

const DAY = 86_400_000;

describe("ConciergeTasksRepository", () => {
  let testDb: TestDb;
  let repo: ConciergeTasksRepository;
  let chats: WebChatRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new ConciergeTasksRepository(testDb.db);
    chats = new WebChatRepository(testDb.db);
  });
  afterEach(() => testDb.close());

  it("creates and updates rows in one batch", async () => {
    const [made] = await repo.upsertMany([{ title: "Book flights", state: "next", rank: 2 }]);
    expect(made).toMatchObject({
      title: "Book flights",
      state: "next",
      rank: 2,
      completedAt: null,
    });

    const [updated, created] = await repo.upsertMany([
      { id: made.id, state: "watching", waitingOn: "CI", summary: "Waiting for the run" },
      { title: "Renew passport" },
    ]);
    expect(updated).toMatchObject({
      id: made.id,
      title: "Book flights",
      state: "watching",
      waitingOn: "CI",
      rank: 2,
    });
    expect(created).toMatchObject({ title: "Renew passport", state: "next" });
  });

  it("applies a batch whole or not at all", async () => {
    await expect(
      repo.upsertMany([{ title: "First" }, { id: "missing", state: "done" }]),
    ).rejects.toThrow("No task missing");
    expect(await repo.listForAgent(true)).toEqual([]);
    await expect(repo.upsertMany([{ state: "doing" }])).rejects.toThrow("needs a title");
  });

  it("sets completedAt on done or dropped and clears it on reopen", async () => {
    const [row] = await repo.upsertMany([{ title: "Task", state: "doing" }]);
    const done = new Date(Date.now() + 1000);
    const [finished] = await repo.upsertMany([{ id: row.id, state: "done" }], done);
    expect(finished.completedAt).toEqual(done);
    const [dropped] = await repo.upsertMany(
      [{ id: row.id, state: "dropped" }],
      new Date(Date.now() + 2000),
    );
    expect(dropped.completedAt).toEqual(done);
    const [reopened] = await repo.upsertMany([{ id: row.id, state: "doing" }]);
    expect(reopened.completedAt).toBeNull();
  });

  it("links a chat to one row and says which row holds it", async () => {
    await chats.createSession("chat-1", "Chat one");
    const [first] = await repo.upsertMany([{ title: "A", state: "doing", sessionId: "chat-1" }]);
    await expect(repo.upsertMany([{ title: "B", sessionId: "chat-1" }])).rejects.toThrow(
      `Chat chat-1 is already linked to task ${first.id}`,
    );
    expect((await repo.findBySession("chat-1"))?.id).toBe(first.id);
    // Writing the row that holds the chat is not a conflict.
    await repo.upsertMany([{ id: first.id, sessionId: "chat-1", summary: "still here" }]);
    // Unlinking frees the chat.
    await repo.upsertMany([{ id: first.id, sessionId: null }]);
    await repo.upsertMany([{ title: "B", sessionId: "chat-1" }]);
  });

  it("keeps a row, unlinked, when its chat is deleted", async () => {
    await chats.createSession("chat-1", "Chat one");
    const [row] = await repo.upsertMany([{ title: "A", state: "doing", sessionId: "chat-1" }]);
    await chats.deleteSession("chat-1");
    expect(await repo.get(row.id)).toMatchObject({ id: row.id, sessionId: null });
  });

  it("lists open rows whatever their age and finished rows only inside the window", async () => {
    const now = Date.now();
    const old = new Date(now - 30 * DAY);
    await repo.upsertMany([{ title: "Old watch", state: "watching" }], old);
    await repo.upsertMany([{ title: "Old done", state: "done" }], old);
    await repo.upsertMany([{ title: "Old dropped", state: "dropped" }], old);
    await repo.upsertMany([{ title: "Fresh done", state: "done" }], new Date(now - DAY));
    const [archived] = await repo.upsertMany([{ title: "Archived", state: "done" }]);
    await repo.upsertMany([{ id: archived.id, archived: true }]);

    const titles = (await repo.listForPanel(new Date(now - 7 * DAY))).map(({ row }) => row.title);
    expect(titles.sort()).toEqual(["Fresh done", "Old watch"]);
    expect((await repo.listForAgent(false)).map(({ row }) => row.title)).toEqual(["Old watch"]);
  });

  it("carries the linked chat's current name", async () => {
    await chats.createSession("chat-1", "Chat one");
    const [row] = await repo.upsertMany([{ title: "A", sessionId: "chat-1" }]);
    await chats.updateSessionName("chat-1", "Renamed");
    expect((await repo.getWithChat(row.id))?.chat).toEqual({ id: "chat-1", name: "Renamed" });
  });

  describe("source message", () => {
    const say = async (chatId: string, text = "Hello") =>
      (await chats.addBackendMessage(chatId, "turn-1", [{ type: "text", content: text }])).id;
    const sourceOf = async (id: string) => (await repo.getWithChat(id))?.sourceMessageId;

    it("answers the id while the message is in the Concierge chat, and null once it is gone", async () => {
      await chats.createSession("concierge", "Concierge");
      const messageId = await say("concierge");
      const [row] = await repo.upsertMany([{ title: "A", sourceMessageId: messageId }]);
      expect(row.sourceMessageId).toBe(messageId);
      expect(await sourceOf(row.id)).toBe(messageId);
      expect((await repo.listForPanel(new Date(0)))[0].sourceMessageId).toBe(messageId);

      testDb.db.delete(romeAgentMessages).where(eq(romeAgentMessages.id, messageId)).run();
      expect(await sourceOf(row.id)).toBeNull();
      // The row keeps the id it was given: nothing is copied or cleared.
      expect((await repo.get(row.id))?.sourceMessageId).toBe(messageId);
    });

    it("counts only a user or assistant message of the Concierge chat", async () => {
      await chats.createSession("concierge", "Concierge");
      await chats.createSession("other", "Other");
      const foreign = await say("other");
      const [row] = await repo.upsertMany([{ title: "A", sourceMessageId: foreign }]);
      expect(await sourceOf(row.id)).toBeNull();

      const trace = await say("concierge");
      testDb.db
        .update(romeAgentMessages)
        .set({ role: "trace" })
        .where(eq(romeAgentMessages.id, trace))
        .run();
      await repo.upsertMany([{ id: row.id, sourceMessageId: trace }]);
      expect(await sourceOf(row.id)).toBeNull();
    });

    it("keeps the message on a later write unless one is given", async () => {
      await chats.createSession("concierge", "Concierge");
      const first = await say("concierge");
      const second = await say("concierge");
      const [row] = await repo.upsertMany([{ title: "A", sourceMessageId: first }]);
      await repo.upsertMany([{ id: row.id, summary: "Later" }]);
      expect(await sourceOf(row.id)).toBe(first);
      await repo.upsertMany([{ id: row.id, sourceMessageId: second }]);
      expect(await sourceOf(row.id)).toBe(second);
    });

    it("is null for a row that never had one", async () => {
      const [row] = await repo.upsertMany([{ title: "A" }]);
      expect(await sourceOf(row.id)).toBeNull();
    });
  });

  it("finds rows whose chat was active after the row was written", async () => {
    await chats.createSession("quiet", "Quiet");
    await chats.createSession("busy", "Busy");
    await chats.createSession("archived", "Archived");
    const longAgo = new Date(Date.now() - 3600_000);
    await repo.upsertMany(
      [
        { title: "Quiet", sessionId: "quiet" },
        { title: "Busy", sessionId: "busy" },
        { title: "Archived", sessionId: "archived", archived: true },
        { title: "No chat" },
      ],
      longAgo,
    );
    await repo.upsertMany([{ id: (await repo.findBySession("quiet"))!.id, summary: "now" }]);
    expect((await repo.listBehindTheirChat()).map((row) => row.title)).toEqual(["Busy"]);
  });

  it("tells the change listeners once a batch is stored", async () => {
    const seen: string[] = [];
    repo.onChange(({ row }, change) => seen.push(`${row.title}:${row.state}:${change}`));
    const [first] = await repo.upsertMany([{ title: "A", state: "doing" }, { title: "B" }]);
    await expect(repo.upsertMany([{ title: "C" }, { id: "nope" }])).rejects.toThrow();
    expect(seen).toEqual(["A:doing:write", "B:next:write"]);
    // A row looked at again is told apart from a row written.
    await repo.reannounce(first.id);
    expect(seen.at(-1)).toBe("A:doing:refresh");
  });
});
