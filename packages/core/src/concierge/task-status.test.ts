import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { approvalWaits } from "../test/open-waits.js";
import {
  type ConciergeTaskFacts,
  legacyTaskState,
  messageStatus,
  parseTaskStatus,
  taskStatus,
} from "@rome/api-types/concierge-task-status";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import { createTestDb, type TestDb } from "../test/db.js";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { makeTask } from "../test/task-chats.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { ConciergeTasks } from "./tasks.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const facts = (extra: Partial<ConciergeTaskFacts> = {}): ConciergeTaskFacts => ({
  stoppedAt: null,
  waitingSince: null,
  running: false,
  reportPending: false,
  laterAt: null,
  lastOutcome: null,
  ...extra,
});

describe("taskStatus", () => {
  it("is ended·stopped once stopped, whatever else holds", () => {
    expect(
      taskStatus(facts({ stoppedAt: 1, waitingSince: NOW, running: true, laterAt: NOW }), NOW),
    ).toEqual({ status: "ended", endReason: "stopped" });
  });

  it("needs its owner while a wait is younger than the expiry, ahead of a running turn", () => {
    expect(taskStatus(facts({ waitingSince: NOW - HOUR, running: true }), NOW)).toEqual({
      status: "needs_you",
      endReason: null,
    });
  });

  it("is active while a turn runs or a result waits to be reported", () => {
    expect(taskStatus(facts({ running: true }), NOW).status).toBe("active");
    expect(taskStatus(facts({ reportPending: true, laterAt: NOW + HOUR }), NOW).status).toBe(
      "active",
    );
  });

  it("is later while a check is pending and nothing runs", () => {
    expect(taskStatus(facts({ laterAt: NOW + HOUR, lastOutcome: "succeeded" }), NOW)).toEqual({
      status: "later",
      endReason: null,
    });
  });

  it("is never later without a check: a task is its task chat, so there is no unstarted one", () => {
    expect(taskStatus(facts(), NOW)).toEqual({ status: "ended", endReason: "done" });
    expect(taskStatus(facts({ stoppedAt: NOW }), NOW)).toEqual({
      status: "ended",
      endReason: "stopped",
    });
  });

  it("ends for no response once a wait is older than the expiry", () => {
    expect(taskStatus(facts({ waitingSince: NOW - 25 * HOUR }), NOW)).toEqual({
      status: "ended",
      endReason: "no_response",
    });
    // A shorter expiry, as a live test sets it.
    expect(taskStatus(facts({ waitingSince: NOW - 2 * HOUR }), NOW, HOUR).endReason).toBe(
      "no_response",
    );
    // An expired wait does not end a task that runs again.
    expect(taskStatus(facts({ waitingSince: NOW - 25 * HOUR, running: true }), NOW).status).toBe(
      "active",
    );
  });

  it("stays ended for no response after a wait Rome ended, whatever the turn after it did", () => {
    expect(taskStatus(facts({ waitExpired: true, lastOutcome: "failed" }), NOW)).toEqual({
      status: "ended",
      endReason: "no_response",
    });
    expect(taskStatus(facts({ waitExpired: true, running: true }), NOW).status).toBe("active");
  });

  it("ends done, failed or stopped by how the task chat's last turn ended", () => {
    expect(taskStatus(facts({ lastOutcome: "succeeded" }), NOW).endReason).toBe("done");
    expect(taskStatus(facts({ lastOutcome: "failed" }), NOW).endReason).toBe("failed");
    expect(taskStatus(facts({ lastOutcome: "stopped" }), NOW).endReason).toBe("stopped");
    expect(taskStatus(facts(), NOW).endReason).toBe("done");
  });
});

describe("messageStatus", () => {
  const turn = { answered: false, working: false, turnFailed: false, tasks: [] };
  const task = (status: "needs_you" | "active" | "later") => ({ status, endReason: null });

  it("works only once its turn shows it working, until the turn answers it", () => {
    expect(messageStatus(turn)).toBeNull();
    expect(messageStatus({ ...turn, working: true })).toBe("working");
    expect(messageStatus({ ...turn, answered: true, working: true })).toBeNull();
    expect(messageStatus({ ...turn, answered: null })).toBeNull();
  });

  it("works while a task made for it is active, and shows none while it waits on its owner or for later", () => {
    const answered = { ...turn, answered: true };
    expect(messageStatus({ ...answered, tasks: [task("active")] })).toBe("working");
    expect(messageStatus({ ...answered, tasks: [task("needs_you")] })).toBeNull();
    expect(messageStatus({ ...answered, tasks: [task("later")] })).toBeNull();
    expect(messageStatus({ ...answered, tasks: [task("later"), task("active")] })).toBe("working");
  });

  it("clears while a task made for it waits on its owner, and works again once it runs", () => {
    const answered = { ...turn, answered: true };
    expect(messageStatus({ ...answered, tasks: [task("active")] })).toBe("working");
    expect(messageStatus({ ...answered, tasks: [task("needs_you")] })).toBeNull();
    // Its turn working keeps it working whatever its task waits on.
    expect(messageStatus({ ...turn, working: true, tasks: [task("needs_you")] })).toBe("working");
    expect(messageStatus({ ...answered, tasks: [task("active")] })).toBe("working");
  });

  it("never works on a message the Concierge reacted to", () => {
    expect(messageStatus({ ...turn, working: true, reacted: true })).toBeNull();
    expect(
      messageStatus({ ...turn, answered: true, reacted: true, tasks: [task("active")] }),
    ).toBeNull();
  });

  it("fails when its turn failed or a task made for it ended failed, once none is still open", () => {
    const failed = { status: "ended" as const, endReason: "failed" as const };
    expect(messageStatus({ ...turn, answered: true, turnFailed: true })).toBe("failed");
    expect(messageStatus({ ...turn, answered: true, tasks: [failed] })).toBe("failed");
    expect(messageStatus({ ...turn, answered: true, tasks: [failed, task("later")] })).toBeNull();
  });

  it("shows none for a failed turn whose task got done", () => {
    const done = { status: "ended" as const, endReason: "done" as const };
    expect(messageStatus({ ...turn, answered: true, turnFailed: true, tasks: [done] })).toBeNull();
  });

  it("fails for a result Rome gave up telling, unless its task was stopped or got no response", () => {
    const lost = { status: "ended" as const, reportLost: true };
    const answered = { ...turn, answered: true };
    expect(messageStatus({ ...answered, tasks: [{ ...lost, endReason: "done" }] })).toBe("failed");
    expect(messageStatus({ ...answered, tasks: [{ ...lost, endReason: "stopped" }] })).toBeNull();
    expect(
      messageStatus({ ...answered, tasks: [{ ...lost, endReason: "no_response" }] }),
    ).toBeNull();
  });
});

describe("legacyTaskState", () => {
  it("maps each status to the state an app from before reads", () => {
    expect(legacyTaskState({ status: "needs_you", endReason: null })).toBe("needs_user");
    expect(legacyTaskState({ status: "active", endReason: null })).toBe("doing");
    expect(legacyTaskState({ status: "later", endReason: null })).toBe("watching");
    expect(legacyTaskState({ status: "ended", endReason: "done" })).toBe("done");
    for (const endReason of ["failed", "stopped", "no_response"] as const) {
      expect(legacyTaskState({ status: "ended", endReason })).toBe("dropped");
    }
  });
});

describe("parseTaskStatus", () => {
  it("reads a status it does not know as active, and an end reason it does not know as done", () => {
    expect(parseTaskStatus("sleeping", null)).toEqual({ status: "active", endReason: null });
    expect(parseTaskStatus(undefined, undefined)).toEqual({ status: "active", endReason: null });
    expect(parseTaskStatus("ended", "vanished")).toEqual({ status: "ended", endReason: "done" });
    expect(parseTaskStatus("later", "done")).toEqual({ status: "later", endReason: null });
    expect(parseTaskStatus("ended", "no_response")).toEqual({
      status: "ended",
      endReason: "no_response",
    });
  });
});

describe("ConciergeTasks status", () => {
  let testDb: TestDb;
  let repo: ConciergeTasksRepository;
  let tasks: ConciergeTasks;
  let chats: ChatsWebChatRepository;
  const running = new Set<string>();
  const waiting = new Map<string, number>();
  const checks = new Map<string, number>();
  let told: ConciergeTaskDto[];
  const make = (title = "Flights", id = "task-chat") => makeTask({ chats, repo }, { id, title });

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new ConciergeTasksRepository(testDb.db);
    chats = new ChatsWebChatRepository(testDb.db);
    tasks = new ConciergeTasks(repo, 24 * HOUR);
    running.clear();
    waiting.clear();
    checks.clear();
    tasks.attachFacts({
      now: () => NOW,
      running: (chatId) => running.has(chatId),
      openWaits: async (chatIds) =>
        approvalWaits(
          new Map(chatIds.flatMap((id) => (waiting.has(id) ? [[id, waiting.get(id)!]] : []))),
        ),
      reportPending: () => [],
      laterOf: async () => new Map(checks),
    });
    told = [];
    // What the task list and the push hear: each announced row, read with its status.
    repo.onChange((task) => {
      void tasks.toDtos([task]).then(([read]) => told.push(read!));
    });
  });
  afterEach(() => testDb.close());

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const statusOf = async (id = "task-chat") =>
    (await tasks.statusOf([(await repo.get(id))!])).get(id);

  it("reads a task's status from its task chat's facts and its row alone, for each status and end reason", async () => {
    await make();
    // Needs you: a wait on its owner, ahead of a running turn.
    waiting.set("task-chat", NOW - HOUR);
    running.add("task-chat");
    expect(await statusOf()).toMatchObject({ status: "needs_you", endReason: null });
    // Active: a turn runs.
    waiting.clear();
    expect(await statusOf()).toMatchObject({ status: "active", endReason: null });
    // Later: a check is scheduled and nothing runs.
    running.clear();
    checks.set("task-chat", NOW + HOUR);
    expect(await statusOf()).toMatchObject({
      status: "later",
      endReason: null,
      laterAt: NOW + HOUR,
    });
    checks.clear();
    // Ended·done: nothing holds it, and its last turn succeeded.
    await repo.setLastOutcome("task-chat", "succeeded", new Date(NOW), { reported: false });
    expect(await statusOf()).toMatchObject({ status: "ended", endReason: "done" });
    // Ended·failed.
    await repo.setLastOutcome("task-chat", "failed", new Date(NOW), { reported: false });
    expect(await statusOf()).toMatchObject({ status: "ended", endReason: "failed" });
    // Ended·no response: a wait Rome ended.
    await repo.markWaitExpired("task-chat", new Date(NOW - 25 * HOUR));
    expect(await statusOf()).toMatchObject({ status: "ended", endReason: "no_response" });
    await repo.clearWaitExpired("task-chat");
    // Ended·stopped: whoever stopped it, whatever else holds.
    await repo.stop("task-chat");
    running.add("task-chat");
    expect(await statusOf()).toMatchObject({ status: "ended", endReason: "stopped" });
  });

  it("sends each row with its status, the chat's name, and the old state mapped from it", async () => {
    await make();
    running.add("task-chat");
    expect(await tasks.listForPanel()).toMatchObject([
      { id: "task-chat", title: "Flights", status: "active", endReason: null, state: "doing" },
    ]);
    running.delete("task-chat");
    waiting.set("task-chat", NOW - HOUR);
    expect(await tasks.listForPanel()).toMatchObject([
      { status: "needs_you", state: "needs_user", waitingSince: NOW - HOUR },
    ]);
  });

  it("names a task by its chat, so a rename is the task's", async () => {
    await make();
    await chats.updateSessionName("task-chat", "Book direct flights");
    expect(await tasks.listForPanel()).toMatchObject([
      {
        id: "task-chat",
        title: "Book direct flights",
        chat: { id: "task-chat", name: "Book direct flights" },
      },
    ]);
  });

  it("keeps a task running while its ended turn's outcome is written, so its status does not flicker", async () => {
    await make();
    const release = tasks.holdRunning("task-chat");
    expect((await statusOf())?.status).toBe("active");
    release();
    release();
    expect((await statusOf())?.status).toBe("ended");
  });

  it("writes nothing when it reads a status, so when a task ended never depends on when it was read", async () => {
    await make();
    await flush();
    await repo.keepEnded([], ["task-chat"]);
    await statusOf();
    expect((await repo.get("task-chat"))?.endedAt).toBeNull();
  });

  it("keeps when a task ended as its facts change, and forgets it when the task opens again", async () => {
    await make();
    await tasks.chatChanged("task-chat");
    expect((await repo.get("task-chat"))?.endedAt).toEqual(new Date(NOW));
    await repo.markWaitExpired("task-chat", new Date(NOW - HOUR));
    running.add("task-chat");
    await tasks.chatChanged("task-chat");
    // Open for a while, as while Rome's own turn after a turned-down approval
    // runs: its no-response note stays for the next digest.
    expect(await repo.get("task-chat")).toMatchObject({ endedAt: null, noResponseUnlisted: true });
    running.delete("task-chat");
    expect(await statusOf()).toMatchObject({ status: "ended", endReason: "no_response" });
    // Someone writing to it ends the no-response, note and all.
    await repo.clearWaitExpired("task-chat");
    expect((await repo.get("task-chat"))?.noResponseUnlisted).toBe(false);
  });

  it("tells a task's new status even when a read saw it first", async () => {
    await make();
    await flush();
    told = [];
    running.add("task-chat");
    // The panel reads the list after the fact changed and before its re-check.
    await tasks.listForPanel();
    await tasks.chatChanged("task-chat");
    await flush();
    expect(told.map((task) => [task.id, task.status])).toEqual([["task-chat", "active"]]);
  });

  it("tells a task again when a fact of its chat changes its status, and only then", async () => {
    await make();
    await flush();
    told = [];
    running.add("task-chat");
    await tasks.chatChanged("task-chat");
    await flush();
    expect(told.map((task) => [task.id, task.status])).toEqual([["task-chat", "active"]]);
    // A change that leaves the status as it was tells nothing.
    await tasks.chatChanged("task-chat");
    await flush();
    expect(told).toHaveLength(1);

    running.delete("task-chat");
    await repo.setLastOutcome("task-chat", "failed");
    // Active until the Concierge reports the result.
    await flush();
    expect(told.at(-1)).toMatchObject({ status: "active" });
    await repo.markReported(["task-chat"]);
    await flush();
    expect(told.at(-1)).toMatchObject({ status: "ended", endReason: "failed", state: "dropped" });
  });

  it("shows a message working while its task chat is active, clears while it needs its owner, and settles once the result is told", async () => {
    await make();
    const target = { chatId: "concierge", messageKey: "m1" };
    await repo.takeMessage("turn-1", target);
    await repo.answerMessage(target.chatId, target.messageKey);
    await repo.linkMessage("task-chat", target);
    const statusOfMessage = async () =>
      (await tasks.messageStatusesOf(target.chatId, [target.messageKey])).get(target.messageKey) ??
      null;
    // The task chat runs: the message works for it.
    running.add("task-chat");
    expect(await statusOfMessage()).toBe("working");
    // It asks its owner a question: no longer working, whether or not any card shows.
    waiting.set("task-chat", NOW - HOUR);
    expect(await statusOfMessage()).toBeNull();
    // Its owner answers and it runs again.
    waiting.clear();
    expect(await statusOfMessage()).toBe("working");
    // It finishes, and the result waits to be told: still the message's work.
    running.clear();
    await repo.setLastOutcome("task-chat", "succeeded");
    expect(await statusOfMessage()).toBe("working");
    // Saying the result settles the message for good: a later run leaves it alone.
    await tasks.resultSaid("task-chat");
    expect(await statusOfMessage()).toBeNull();
    running.add("task-chat");
    expect(await statusOfMessage()).toBeNull();
  });
});
