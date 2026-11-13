import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { approvalWaits } from "../test/open-waits.js";
import {
  type ConciergeTaskFacts,
  legacyTaskState,
  messageStatusReaction,
  parseTaskStatus,
  taskStatus,
} from "@rome/api-types/concierge-task-status";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import { createTestDb, type TestDb } from "../test/db.js";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
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
  started: true,
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

  it("is later, with no time, while no task chat was started for it", () => {
    expect(taskStatus(facts({ started: false }), NOW)).toEqual({
      status: "later",
      endReason: null,
    });
    // Stopping it ends it, before its chat ever started.
    expect(taskStatus(facts({ started: false, stoppedAt: NOW }), NOW)).toEqual({
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

describe("messageStatusReaction", () => {
  it("shows failed for a result Rome gave up telling, unless its task was stopped since", () => {
    const lost = { status: "ended" as const, reportLost: true };
    expect(messageStatusReaction({ answered: true, tasks: [{ ...lost, endReason: "done" }] })).toBe(
      "failed",
    );
    expect(
      messageStatusReaction({ answered: true, tasks: [{ ...lost, endReason: "stopped" }] }),
    ).toBeNull();
  });

  it("shows none for a task that ended for no response, even when its report was lost", () => {
    const lost = { status: "ended" as const, reportLost: true, endReason: "no_response" as const };
    expect(messageStatusReaction({ answered: true, tasks: [lost] })).toBeNull();
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
  const running = new Set<string>();
  const waiting = new Map<string, number>();
  let told: ConciergeTaskDto[];

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new ConciergeTasksRepository(testDb.db);
    tasks = new ConciergeTasks(repo, 24 * HOUR);
    running.clear();
    waiting.clear();
    tasks.attachFacts({
      now: () => NOW,
      running: (chatId) => running.has(chatId),
      openWaits: async (chatIds) =>
        approvalWaits(
          new Map(chatIds.flatMap((id) => (waiting.has(id) ? [[id, waiting.get(id)!]] : []))),
        ),
      reportPending: () => [],
    });
    told = [];
    tasks.subscribe((event, payload) => {
      if (event === "task_upsert") told.push((payload as { task: ConciergeTaskDto }).task);
    });
    await new ChatsWebChatRepository(testDb.db).createSession("task-chat", "Flights");
  });
  afterEach(() => testDb.close());

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("sends each row with its status, and the old state mapped from it", async () => {
    await repo.upsertMany([{ title: "Flights", state: "next", sessionId: "task-chat" }]);
    running.add("task-chat");
    expect(await tasks.listForPanel()).toMatchObject([
      { title: "Flights", status: "active", endReason: null, state: "doing" },
    ]);
    running.delete("task-chat");
    waiting.set("task-chat", NOW - HOUR);
    expect(await tasks.listForPanel()).toMatchObject([
      { status: "needs_you", state: "needs_user", waitingSince: NOW - HOUR },
    ]);
  });

  it("reads a row with no task chat as later until its chat starts, and ended·stopped once stopped", async () => {
    const [row] = await repo.upsertMany([{ title: "Follow the launch" }]);
    expect(await tasks.listForPanel()).toMatchObject([
      { status: "later", endReason: null, laterAt: null },
    ]);

    await repo.upsertMany([{ id: row!.id, sessionId: "task-chat" }]);
    running.add("task-chat");
    expect(await tasks.listForPanel()).toMatchObject([{ status: "active" }]);

    const [other] = await repo.upsertMany([{ title: "Watch the price" }]);
    await repo.stop(other!.id, "concierge");
    expect((await tasks.statusOf([(await repo.get(other!.id))!])).get(other!.id)).toMatchObject({
      status: "ended",
      endReason: "stopped",
    });
  });

  it("keeps a task running while its ended turn's outcome is written, so its status does not flicker", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    const release = tasks.holdRunning("task-chat");
    expect((await tasks.statusOf([row!])).get(row!.id)?.status).toBe("active");
    release();
    release();
    expect((await tasks.statusOf([row!])).get(row!.id)?.status).toBe("ended");
  });

  it("writes nothing when it reads a status, so when a task ended never depends on when it was read", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    await flush();
    await repo.keepEnded([], [row!.id]);
    await tasks.statusOf([(await repo.get(row!.id))!]);
    expect((await repo.get(row!.id))?.endedAt).toBeNull();
  });

  it("keeps when a task ended as its facts change, and forgets it when the task opens again", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    await tasks.chatChanged("task-chat");
    expect((await repo.get(row!.id))?.endedAt).toEqual(new Date(NOW));
    await repo.markWaitExpired(row!.id, new Date(NOW - HOUR));
    running.add("task-chat");
    await tasks.chatChanged("task-chat");
    // Open for a while, as while Rome's own turn after a turned-down approval
    // runs: its no-response note stays for the next digest.
    expect(await repo.get(row!.id)).toMatchObject({ endedAt: null, noResponseUnlisted: true });
    running.delete("task-chat");
    expect((await tasks.statusOf([(await repo.get(row!.id))!])).get(row!.id)).toMatchObject({
      status: "ended",
      endReason: "no_response",
    });
    // Someone writing to it ends the no-response, note and all.
    await repo.clearWaitExpired(row!.id);
    expect((await repo.get(row!.id))?.noResponseUnlisted).toBe(false);
  });

  it("tells a task's changes in the order they happened", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    await repo.upsertMany([{ id: row.id, summary: "one" }]);
    await repo.upsertMany([{ id: row.id, summary: "two" }]);
    await flush();
    expect(told.map((task) => task.summary)).toEqual([null, "one", "two"]);
  });

  it("tells a task's new status even when a read saw it first", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    await flush();
    told = [];
    running.add("task-chat");
    // The panel reads the list after the fact changed and before its re-check.
    await tasks.listForPanel();
    await tasks.chatChanged("task-chat");
    await flush();
    expect(told.map((task) => [task.id, task.status])).toEqual([[row.id, "active"]]);
  });

  it("tells a task again when a fact of its chat changes its status, and only then", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    await flush();
    told = [];
    running.add("task-chat");
    await tasks.chatChanged("task-chat");
    await flush();
    expect(told.map((task) => [task.id, task.status])).toEqual([[row.id, "active"]]);
    // A change that leaves the status as it was tells nothing.
    await tasks.chatChanged("task-chat");
    await flush();
    expect(told).toHaveLength(1);

    running.delete("task-chat");
    await repo.setLastOutcome(row.id, "failed");
    // Active until the Concierge reports the result.
    await flush();
    expect(told.at(-1)).toMatchObject({ status: "active" });
    await repo.markReported([row.id]);
    await flush();
    expect(told.at(-1)).toMatchObject({ status: "ended", endReason: "failed", state: "dropped" });
  });
});
