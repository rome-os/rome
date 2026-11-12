import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../test/db.js";
import { ChatsWebChatRepository } from "../../webchat/chats-webchat-repository.js";
import {
  chatMessages,
  conciergeTaskReactions,
  conciergeTurnReactions,
  romeSessions,
} from "../schema.js";
import type { WebChatRepository } from "../../webchat/repository.js";
import { ConciergeTasksRepository } from "./concierge-tasks.js";
import { renderTaskEvents } from "../../concierge/events.js";
import { mainChatIdOf } from "../../concierge/main-chat.js";
import type { ConciergeService } from "../../concierge/service.js";

const DAY = 86_400_000;

describe("ConciergeTasksRepository", () => {
  let testDb: TestDb;
  let repo: ConciergeTasksRepository;
  let chats: WebChatRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new ConciergeTasksRepository(testDb.db);
    chats = new ChatsWebChatRepository(testDb.db);
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

  it("lists one Concierge chat's live rows only: open ones, and finished ones whose task chat is active", async () => {
    const now = Date.now();
    const concierge = (id: string, ownerKey: string | null) =>
      chats.createSession(
        id,
        id,
        undefined,
        undefined,
        null,
        undefined,
        "core:concierge",
        "webchat",
        null,
        { ownerKey },
      );
    const visitorMain = mainChatIdOf("visitor:a");
    await concierge("concierge", null);
    await concierge("topic", null);
    await concierge("gone-topic", null);
    await concierge(visitorMain, "visitor:a");
    await repo.upsertMany([{ title: "Main's", state: "doing" }]);
    await repo.upsertMany([{ title: "Topic's", state: "doing", chatId: "topic" }]);
    await repo.upsertMany([{ title: "Gone topic's", state: "doing", chatId: "gone-topic" }]);
    await repo.upsertMany([{ title: "Visitor's", state: "doing", chatId: visitorMain }]);
    await repo.upsertMany([{ title: "Old done", state: "done" }], new Date(now - 30 * DAY));
    // Finished long ago, with a task chat: one resumed now, one quiet since.
    await chats.createSession("resumed-chat", "Resumed");
    await chats.createSession("quiet-chat", "Quiet");
    await testDb.db
      .update(romeSessions)
      .set({ activityAt: new Date(now - 30 * DAY) })
      .where(eq(romeSessions.id, "quiet-chat"));
    await repo.upsertMany(
      [
        { title: "Resumed old task", state: "done", sessionId: "resumed-chat" },
        { title: "Quiet old task", state: "done", sessionId: "quiet-chat" },
      ],
      new Date(now - 30 * DAY),
    );
    await chats.deleteSession("gone-topic");
    const since = new Date(now - 7 * DAY);
    const titles = async (chatId: string, owner: string) =>
      (await repo.listForConciergeChat(chatId, owner, since)).map(({ row }) => row.title).sort();

    expect(await titles("concierge", "guardian")).toEqual([
      "Gone topic's",
      "Main's",
      "Resumed old task",
    ]);
    expect(await titles("topic", "guardian")).toEqual(["Topic's"]);
    expect(await titles(visitorMain, "visitor:a")).toEqual(["Visitor's"]);
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
      // The row holds the message's id in Chats, and answers its key.
      expect(row.sourceMessageId).toEqual(expect.any(Number));
      expect(await sourceOf(row.id)).toBe(messageId);
      expect((await repo.listForPanel(new Date(0)))[0].sourceMessageId).toBe(messageId);

      testDb.db.delete(chatMessages).where(eq(chatMessages.key, messageId)).run();
      expect(await sourceOf(row.id)).toBeNull();
      // The message's going clears the row's pointer; no text was copied.
      expect((await repo.get(row.id))?.sourceMessageId).toBeNull();
    });

    it("counts only a user or assistant message of the Concierge chat", async () => {
      await chats.createSession("concierge", "Concierge");
      await chats.createSession("other", "Other");
      const foreign = await say("other");
      const [row] = await repo.upsertMany([{ title: "A", sourceMessageId: foreign }]);
      expect(await sourceOf(row.id)).toBeNull();

      // A trace is the agent's own row, never a message of the chat.
      const trace = "trace-1";
      await chats.addMessage(trace, "concierge", "trace", "[]", "turn-1");
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
    it("looks the message up in the row's own Concierge chat", async () => {
      await chats.createSession("concierge", "Concierge");
      await chats.createSession(
        "topic-1",
        "Calendar",
        undefined,
        undefined,
        null,
        undefined,
        "core:concierge",
      );
      const inTopic = await say("topic-1");
      const [row] = await repo.upsertMany([
        { title: "A", chatId: "topic-1", sourceMessageId: inTopic },
      ]);
      expect(await sourceOf(row.id)).toBe(inTopic);
      // The same message named for a row of the main chat is not its source.
      const [other] = await repo.upsertMany([{ title: "B", sourceMessageId: inTopic }]);
      expect(await sourceOf(other.id)).toBeNull();
    });
  });

  describe("Concierge chat of a row", () => {
    it("is the main chat unless the row names another, and the main chat once that chat is gone", async () => {
      await chats.createSession("concierge", "Concierge");
      await chats.createSession(
        "topic-1",
        "Calendar",
        undefined,
        undefined,
        null,
        undefined,
        "core:concierge",
      );
      const [main, topic] = await repo.upsertMany([
        { title: "A", chatId: "concierge" },
        { title: "B", chatId: "topic-1" },
      ]);
      // The main chat is stored as no chat.
      expect(main.chatId).toBeNull();
      expect((await repo.getWithChat(main.id))?.conciergeChat).toEqual({
        id: "concierge",
        name: "Concierge",
        main: true,
      });
      expect((await repo.getWithChat(topic.id))?.conciergeChat).toEqual({
        id: "topic-1",
        name: "Calendar",
        main: false,
      });
      await chats.deleteSession("topic-1");
      expect((await repo.getWithChat(topic.id))?.conciergeChat.main).toBe(true);
    });

    it("gives a finished row of an archived chat to the main chat, where its buttons can write", async () => {
      await chats.createSession("concierge", "Concierge");
      await chats.createSession(
        "topic-1",
        "Calendar",
        undefined,
        undefined,
        null,
        undefined,
        "core:concierge",
      );
      const [done] = await repo.upsertMany([{ title: "Old", chatId: "topic-1", state: "done" }]);
      expect((await repo.getWithChat(done.id))?.conciergeChat.id).toBe("topic-1");
      await chats.archiveSession("topic-1");
      expect((await repo.getWithChat(done.id))?.conciergeChat).toEqual({
        id: "concierge",
        name: "Concierge",
        main: true,
      });
      // The row still names its chat, so unarchiving gives it back.
      expect((await repo.get(done.id))?.chatId).toBe("topic-1");
    });

    it("moves only the unfinished rows of a chat to the main chat, and announces each", async () => {
      await chats.createSession(
        "topic-1",
        "Calendar",
        undefined,
        undefined,
        null,
        undefined,
        "core:concierge",
      );
      const [open, done] = await repo.upsertMany([
        { title: "A", chatId: "topic-1", state: "doing" },
        { title: "B", chatId: "topic-1", state: "done" },
      ]);
      const announced: string[] = [];
      repo.onChange(({ row }) => announced.push(row.id));
      expect(await repo.moveToMainChat("topic-1")).toBe(1);
      expect((await repo.get(open.id))?.chatId).toBeNull();
      expect((await repo.get(done.id))?.chatId).toBe("topic-1");
      expect(announced).toEqual([open.id]);
    });

    it("keeps a row its owner's when its chat is deleted without moving it", async () => {
      const owner = "visitor:acct-ann";
      const main = mainChatIdOf(owner);
      for (const id of [main, "ann-topic"]) {
        await chats.createSession(
          id,
          "Concierge",
          undefined,
          undefined,
          null,
          undefined,
          "core:concierge",
          "webchat",
          null,
          { ownerKey: owner },
        );
      }
      const [row] = await repo.upsertMany([{ title: "A", chatId: "ann-topic", state: "doing" }]);
      // Deleting the chat clears the row's link to it; the owner is the row's own.
      await chats.deleteSession("ann-topic");
      expect((await repo.get(row.id))?.chatId).toBeNull();
      expect(await repo.getWithChat(row.id)).toMatchObject({
        owner,
        conciergeChat: { id: main, main: true },
      });
      // Its task events group under that owner's main chat, never the guardian's.
      const service = {
        deps: { tasks: { repo }, messages: { recent: async () => [], before: async () => [] } },
        dashboard: { chats: { activeTurns: () => [] } },
      } as unknown as ConciergeService;
      const [delivery] = await renderTaskEvents(service, [
        { taskId: row.id, changes: [{ kind: "summary" } as never], quiet: true },
      ]);
      // A held row is its owner's and that chat's, however often its turn waits.
      expect(delivery).toMatchObject({ chatId: main, owner, taskIds: [row.id] });
    });

    it("keeps a visitor's rows, finished ones too, theirs after their topic chat is deleted", async () => {
      const owner = "visitor:acct-ann";
      const main = mainChatIdOf(owner);
      for (const id of [main, "ann-topic"]) {
        await chats.createSession(
          id,
          "Concierge",
          undefined,
          undefined,
          null,
          undefined,
          "core:concierge",
          "webchat",
          null,
          { ownerKey: owner },
        );
      }
      const [open, done] = await repo.upsertMany([
        { title: "A", chatId: "ann-topic", state: "doing" },
        { title: "B", chatId: "ann-topic", state: "done" },
      ]);
      await repo.moveToMainChat("ann-topic", main);
      await chats.deleteSession("ann-topic");
      for (const id of [open.id, done.id]) {
        expect(await repo.getWithChat(id)).toMatchObject({
          owner,
          conciergeChat: { id: main, main: true },
        });
      }
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
  describe("status reactions and chat threads", () => {
    const conciergeChat = (id: string, ownerKey: string | null = null) =>
      chats.createSession(
        id,
        id,
        undefined,
        undefined,
        null,
        undefined,
        "core:concierge",
        "webchat",
        null,
        { ownerKey },
      );
    const turnRows = () => testDb.db.select().from(conciergeTurnReactions).all();
    const taskRows = () => testDb.db.select().from(conciergeTaskReactions).all();

    it("keeps no row for a turn's mark that ended well, and keeps a failed one", async () => {
      await repo.markTurnWorking("t1", { chatId: "concierge", messageKey: "g1" });
      await repo.markTurnWorking("t2", { chatId: "concierge", messageKey: "g2" });
      await repo.settleAnsweredTurnReaction("concierge", "g1");
      expect(turnRows().map((row) => row.messageKey)).toEqual(["g2"]);
      await repo.settleTurnReactions("concierge", "failed", []);
      expect(turnRows()).toMatchObject([{ messageKey: "g2", state: "failed" }]);
      await repo.markTurnWorking("t3", { chatId: "concierge", messageKey: "g3" });
      await repo.settleTurnReactions("concierge", "stopped", []);
      expect(turnRows().map((row) => row.messageKey)).toEqual(["g2"]);
      expect(await repo.reactionsOf("concierge", ["g1", "g2", "g3"])).toEqual(
        new Map([["g2", "failed"]]),
      );
    });

    it("forgets a deleted chat's marks, and no other chat's", async () => {
      const [task] = await repo.upsertMany([{ title: "A", state: "doing" }]);
      await repo.markWorking(task!.id, { chatId: "topic", messageKey: "g1" });
      await repo.markWorking(task!.id, { chatId: "concierge", messageKey: "g2" });
      await repo.markTurnWorking("t1", { chatId: "topic", messageKey: "g3" });
      await repo.forgetReactions("topic");
      expect(taskRows().map((row) => row.messageKey)).toEqual(["g2"]);
      expect(turnRows()).toEqual([]);
    });

    it("tells a visitor's main chat, not the guardian's, when a task leaves it", async () => {
      const owner = "visitor:acct-ann";
      const main = mainChatIdOf(owner);
      await conciergeChat(main, owner);
      await conciergeChat("ann-topic", owner);
      await conciergeChat("ann-other", owner);
      const [row] = await repo.upsertMany([{ title: "A", chatId: "ann-topic", state: "doing" }]);
      await repo.setThreadRoot(row!.id, "r1");
      // The topic is deleted: the row is its owner's main chat's, unlinked.
      await chats.deleteSession("ann-topic");
      const retired: unknown[] = [];
      repo.onThreadRetired((event) => retired.push(event));
      await repo.upsertMany([{ id: row!.id, chatId: "ann-other" }]);
      expect(retired).toEqual([{ chatId: main, root: "r1" }]);
    });
  });
});
