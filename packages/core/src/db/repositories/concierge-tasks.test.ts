import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../test/db.js";
import { makeTask } from "../../test/task-chats.js";
import { ChatsWebChatRepository } from "../../webchat/chats-webchat-repository.js";
import type { WebChatRepository } from "../../webchat/repository.js";
import { mainChatIdOf } from "../../concierge/main-chat.js";
import { conciergeMessageTasks, romeSessions, taskChats } from "../schema.js";
import { taskStatus } from "@rome/api-types/concierge-task-status";
import { ConciergeTasksRepository } from "./concierge-tasks.js";

const DAY = 86_400_000;

describe("ConciergeTasksRepository: a task is its task chat", () => {
  let testDb: TestDb;
  let repo: ConciergeTasksRepository;
  let chats: WebChatRepository;
  const make = (input: Parameters<typeof makeTask>[1]) => makeTask({ chats, repo }, input);

  beforeEach(() => {
    testDb = createTestDb();
    repo = new ConciergeTasksRepository(testDb.db);
    chats = new ChatsWebChatRepository(testDb.db);
  });
  afterEach(() => testDb.close());

  it("reads the task's id, name, owner and archive state from its chat", async () => {
    const task = await make({ id: "chat-1", title: "Book flights", ownerKey: "visitor:ann" });
    expect(task).toMatchObject({
      id: "chat-1",
      sessionId: "chat-1",
      title: "Book flights",
      ownerKey: "visitor:ann",
      archivedAt: null,
      stoppedAt: null,
    });
    // Renaming the chat renames the task: one name.
    await chats.updateSessionName("chat-1", "Book direct flights");
    expect((await repo.getWithChat("chat-1"))?.chat).toEqual({
      id: "chat-1",
      name: "Book direct flights",
    });
    expect((await repo.get("chat-1"))?.title).toBe("Book direct flights");
  });

  it("reports to the main chat unless its Concierge chat is a live topic chat", async () => {
    await chats.createSession(
      "topic-1",
      "Trips",
      undefined,
      undefined,
      null,
      undefined,
      "core:concierge",
    );
    await make({ id: "chat-main", title: "A" });
    await make({ id: "chat-topic", title: "B", chatId: "topic-1" });
    expect((await repo.getWithChat("chat-main"))?.conciergeChat).toMatchObject({
      id: mainChatIdOf("guardian"),
      main: true,
    });
    expect((await repo.getWithChat("chat-topic"))?.conciergeChat).toEqual({
      id: "topic-1",
      name: "Trips",
      main: false,
    });
    // An archived topic chat's tasks read as the main chat's.
    await chats.archiveSession("topic-1");
    expect((await repo.getWithChat("chat-topic"))?.conciergeChat.main).toBe(true);
    // A deleted one leaves the row reporting to the main chat.
    await chats.deleteSession("topic-1");
    expect((await repo.getWithChat("chat-topic"))?.conciergeChat.main).toBe(true);
    expect((await repo.get("chat-topic"))?.chatId).toBeNull();
  });

  it("makes no task for a chat or a Concierge chat it cannot find", async () => {
    await expect(repo.create("missing", {})).rejects.toThrow("No chat missing");
    await chats.createSession("chat-1", "A");
    await expect(repo.create("chat-1", { chatId: "gone-topic" })).rejects.toThrow(
      "No Concierge chat gone-topic",
    );
    expect(await repo.listForAgent(true)).toEqual([]);
  });

  it("takes the owner's mark of done off when the task is taken up again, so a later Stop reads stopped", async () => {
    await make({ id: "chat-1", title: "Book flights" });
    const statusOf = async () => {
      const row = (await repo.get("chat-1"))!;
      return taskStatus(
        {
          stoppedAt: row.stoppedAt?.getTime() ?? null,
          waitingSince: null,
          running: false,
          reportPending: false,
          laterAt: null,
          lastOutcome: row.lastOutcome,
        },
        Date.now(),
      );
    };
    expect(await repo.markDone("chat-1")).toBe(true);
    expect(await statusOf()).toEqual({ status: "ended", endReason: "done" });
    // New words take it up again: the mark goes with the stop.
    expect(await repo.resume("chat-1")).toBe(true);
    expect((await repo.get("chat-1"))?.lastOutcome).toBeNull();
    // Stopped before the new turn ends, it reads stopped, and the turn's
    // own "stopped" outcome still lands.
    await repo.stop("chat-1");
    await repo.setLastOutcome("chat-1", "stopped");
    expect(await statusOf()).toEqual({ status: "ended", endReason: "stopped" });
    expect((await repo.get("chat-1"))?.lastOutcome).toBe("stopped");
  });

  it("ends a task stopped by any other way than its owner's mark stopped, never done", async () => {
    await make({ id: "chat-2", title: "Hotels" });
    // A mark left on a running task (as one written before resume cleared it).
    testDb.db
      .update(taskChats)
      .set({ lastOutcome: "done_by_owner" })
      .where(eq(taskChats.sessionId, "chat-2"))
      .run();
    await repo.stop("chat-2");
    expect((await repo.get("chat-2"))?.lastOutcome).toBeNull();
  });

  it("stops a task, and takes it up again unless its chat is archived", async () => {
    await make({ id: "chat-1", title: "A" });
    await repo.stop("chat-1");
    const stoppedAt = (await repo.get("chat-1"))?.stoppedAt;
    expect(stoppedAt).toEqual(expect.any(Date));
    // A later stop changes nothing.
    await repo.stop("chat-1");
    expect((await repo.get("chat-1"))?.stoppedAt).toEqual(stoppedAt);
    expect(await repo.resume("chat-1")).toBe(true);
    expect((await repo.get("chat-1"))?.stoppedAt).toBeNull();

    await repo.stop("chat-1");
    await chats.archiveSession("chat-1");
    expect(await repo.resume("chat-1")).toBe(false);
    await chats.unarchiveSession("chat-1");
    expect(await repo.resume("chat-1")).toBe(true);
  });

  describe("a task chat that ends", () => {
    it("stops its task in the chat's own archive, which archives the task", async () => {
      await make({ id: "chat-1", title: "A" });
      const announced: string[] = [];
      repo.onChange(({ row }) => announced.push(row.id));
      const ended = await repo.endWithChat("chat-1", "guardian", "archived", (tx) =>
        chats.archiveSessionIn(tx, "chat-1"),
      );
      expect(ended).toMatchObject({ id: "chat-1", stoppedAt: expect.any(Date) });
      expect(await repo.get("chat-1")).toMatchObject({
        stoppedAt: expect.any(Date),
        archivedAt: expect.any(Date),
      });
      expect(announced).toEqual(["chat-1"]);
      // An archived task is out of the Tasks view, and unarchiving lists it again, still stopped.
      expect(await repo.listForPanel(new Date(0))).toEqual([]);
      await chats.unarchiveSession("chat-1");
      expect(await repo.listForPanel(new Date(0))).toHaveLength(1);
      expect((await repo.get("chat-1"))?.stoppedAt).toEqual(expect.any(Date));
    });

    it("keeps how a task that already ended ended", async () => {
      await make({ id: "chat-1", title: "A" });
      await repo.endWithChat(
        "chat-1",
        "guardian",
        "archived",
        (tx) => chats.archiveSessionIn(tx, "chat-1"),
        new Date(),
        false,
      );
      expect((await repo.get("chat-1"))?.stoppedAt).toBeNull();
    });

    it("takes the task and its message links with the chat when it is deleted", async () => {
      await make({ id: "chat-1", title: "A" });
      await repo.linkMessage("chat-1", { chatId: "concierge", messageKey: "m1" });
      const announced: string[] = [];
      repo.onChange(({ row }) => announced.push(row.id));
      const touched: string[] = [];
      repo.onMessageChange(({ messageKey }) => touched.push(messageKey));
      await repo.endWithChat("chat-1", "guardian", "deleted", (tx) =>
        chats.deleteSessionIn(tx, "chat-1"),
      );
      expect(await repo.get("chat-1")).toBeNull();
      expect(testDb.db.select().from(taskChats).all()).toEqual([]);
      expect(testDb.db.select().from(conciergeMessageTasks).all()).toEqual([]);
      // The Tasks view and the message's status are told.
      expect(announced).toEqual(["chat-1"]);
      expect(touched).toContain("m1");
    });

    it("leaves a chat of another owner alone", async () => {
      await make({ id: "chat-1", title: "A", ownerKey: "visitor:ann" });
      const ended = await repo.endWithChat("chat-1", "guardian", "archived", (tx) =>
        chats.archiveSessionIn(tx, "chat-1"),
      );
      expect(ended).toBeNull();
      expect((await repo.get("chat-1"))?.stoppedAt).toBeNull();
    });
  });

  it("marks a task whose first turn failed as ended failed, with nothing to report", async () => {
    await make({ id: "chat-1", title: "A" });
    await repo.markStartFailed("chat-1");
    expect(await repo.get("chat-1")).toMatchObject({ lastOutcome: "failed", outcomeUnsaid: false });
  });

  it("lists a Concierge chat's tasks by the chat it reports to", async () => {
    await chats.createSession(
      "topic-1",
      "Trips",
      undefined,
      undefined,
      null,
      undefined,
      "core:concierge",
    );
    await make({ id: "main-1", title: "Main task" });
    await make({ id: "topic-task", title: "Topic task", chatId: "topic-1" });
    await make({ id: "other", title: "Another owner's", ownerKey: "visitor:ann" });
    const since = new Date(Date.now() - DAY);
    expect(
      (await repo.listForConciergeChat(mainChatIdOf("guardian"), "guardian", since)).map(
        (task) => task.row.id,
      ),
    ).toEqual(["main-1"]);
    expect(
      (await repo.listForConciergeChat("topic-1", "guardian", since)).map((task) => task.row.id),
    ).toEqual(["topic-task"]);
    expect(
      (await repo.taskChatsStartedBy("topic-1", "guardian")).map((chat) => chat.chatId),
    ).toEqual(["topic-task"]);
  });

  it("shows a task that ended inside the window, and none that ended before it", async () => {
    await make({ id: "open", title: "Open" });
    await make({ id: "recent", title: "Recent" });
    await make({ id: "old", title: "Old" });
    const now = new Date();
    await repo.keepEnded(["recent"], [], new Date(now.getTime() - DAY));
    await repo.keepEnded(["old"], [], new Date(now.getTime() - 10 * DAY));
    const shown = await repo.listForPanel(new Date(now.getTime() - 7 * DAY));
    expect(shown.map((task) => task.row.id).sort()).toEqual(["open", "recent"]);
  });

  it("keeps the wait that ended for no response, and clears it once", async () => {
    await make({ id: "chat-1", title: "A" });
    const since = new Date(Date.now() - 2 * DAY);
    expect(await repo.markWaitExpired("chat-1", since)).toBe(true);
    // Rome handles one wait once.
    expect(await repo.markWaitExpired("chat-1", since)).toBe(false);
    expect(await repo.noResponseUnlisted(["chat-1"])).toEqual(["chat-1"]);
    await repo.markNoResponseListed(["chat-1"]);
    expect(await repo.noResponseUnlisted(["chat-1"])).toEqual([]);
    await repo.clearWaitExpired("chat-1");
    expect((await repo.get("chat-1"))?.expiredWaitAt).toBeNull();
  });

  it("writes only a note and where a task points, and tells the listeners", async () => {
    await make({ id: "chat-1", title: "A" });
    const kinds: string[] = [];
    repo.onChange((_, change) => kinds.push(change));
    const row = await repo.write("chat-1", { note: "check the PR" });
    expect(row.note).toBe("check the PR");
    expect((await repo.write("chat-1", { note: null })).note).toBeNull();
    await expect(repo.write("missing", { note: "x" })).rejects.toThrow("No task missing");
    expect(kinds).toEqual(["write", "write"]);
  });

  it("lists the tasks a restart may have missed: chats active after the row was written", async () => {
    await make({ id: "quiet", title: "Quiet" });
    await make({ id: "busy", title: "Busy" });
    testDb.db
      .update(romeSessions)
      .set({ activityAt: new Date(Date.now() + 60_000) })
      .where(eq(romeSessions.id, "busy"))
      .run();
    expect((await repo.listBehindTheirChat()).map((row) => row.id)).toEqual(["busy"]);
  });
});
