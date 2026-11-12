import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { TaskChecks } from "./task-checks.js";

const NOW = Date.UTC(2026, 10, 12, 9);
const HOUR = 3_600_000;

describe("TaskChecks", () => {
  let testDb: TestDb;
  let routines: RoutinesRepository;
  let checks: TaskChecks;
  let listeners: Array<(routineId: string) => void>;
  let deactivated: string[];

  beforeEach(() => {
    testDb = createTestDb();
    routines = new RoutinesRepository(testDb.db);
    listeners = [];
    deactivated = [];
    checks = new TaskChecks({
      routines,
      routineEngine: {
        deactivate: async (id) => void deactivated.push(id),
        onChange: (listener) => {
          listeners.push(listener);
          return () => {};
        },
      },
      now: () => NOW,
    });
  });
  afterEach(() => testDb.close());

  /** A `defer` wake-up of chat `chatId`, timed at `at`, as runDefer stores it. */
  const timed = (chatId: string, at: number, extra: Record<string, unknown> = {}) =>
    routines.create({
      name: `check ${chatId}`,
      trigger: {
        type: "schedule",
        tzid: "UTC",
        tzMode: "fixed",
        localTime: "09:00",
        date: "2026-11-12",
      },
      actionName: "resume_session",
      args: { channel: "webchat", threadId: chatId, sessionId: "s", ...extra },
      nextRunAt: new Date(at),
    });
  /** An event wait of chat `chatId`, with its deadline and label. */
  const waiting = (chatId: string, deadline: number, extra: Record<string, unknown> = {}) =>
    routines.create({
      name: `wait ${chatId}`,
      trigger: { type: "event-bus", eventName: "ci.done", once: true },
      actionName: "resume_session",
      args: {
        channel: "webchat",
        threadId: chatId,
        sessionId: "s",
        waitingFor: "the CI run",
        deadline: new Date(deadline).toISOString(),
        ...extra,
      },
    });

  it("reads a task's soonest pending check, from its time or its deadline", async () => {
    await timed("chat-1", NOW + 2 * HOUR, { taskId: "task-1" });
    await waiting("chat-1", NOW + HOUR, { taskId: "task-1" });
    await timed("chat-1", NOW - HOUR, { taskId: "task-2" }); // fired already
    const other = await timed("chat-1", NOW + HOUR, { taskId: "task-3" });
    await routines.update(other, { enabled: false });
    expect(await checks.laterOf(["task-1", "task-2", "task-3"])).toEqual(
      new Map([["task-1", NOW + HOUR]]),
    );
  });

  it("lists a chat's pending checks, the soonest first, with what an event wait waits for", async () => {
    const later = await timed("chat-1", NOW + 2 * HOUR);
    const soon = await waiting("chat-1", NOW + HOUR, { taskId: "task-1" });
    await timed("chat-2", NOW + HOUR);
    expect(await checks.inChat("chat-1")).toEqual([
      { id: soon, name: "wait chat-1", at: NOW + HOUR, waitingFor: "the CI run", taskId: "task-1" },
      { id: later, name: "check chat-1", at: NOW + 2 * HOUR, waitingFor: null, taskId: null },
    ]);
  });

  it("cancels a check only from its own chat", async () => {
    const id = await timed("chat-1", NOW + HOUR);
    expect(await checks.cancel("chat-2", id)).toBe(false);
    expect(await routines.findById(id)).not.toBeNull();
    expect(await checks.cancel("chat-1", id)).toBe(true);
    expect(await routines.findById(id)).toBeNull();
    expect(deactivated).toEqual([id]);
  });

  it("cancels every check of a task, and no other", async () => {
    await timed("chat-1", NOW + HOUR, { taskId: "task-1" });
    await waiting("chat-1", NOW + HOUR, { taskId: "task-1" });
    const kept = await timed("chat-1", NOW + HOUR, { taskId: "task-2" });
    expect(await checks.cancelFor("task-1")).toBe(2);
    expect((await routines.findAll()).map((routine) => routine.id)).toEqual([kept]);
  });

  it("tells each task whose soonest check came, moved or went", async () => {
    const changed: string[] = [];
    checks.watch((taskId) => changed.push(taskId));
    const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
    await flush();
    const id = await timed("chat-1", NOW + HOUR, { taskId: "task-1" });
    for (const listener of listeners) listener(id);
    await flush();
    expect(changed).toEqual(["task-1"]);
    // A change that moves no task's check tells nothing.
    await timed("chat-1", NOW + 3 * HOUR, { taskId: "task-1" });
    for (const listener of listeners) listener(id);
    await flush();
    expect(changed).toEqual(["task-1"]);
    await checks.cancelFor("task-1");
    for (const listener of listeners) listener(id);
    await flush();
    expect(changed).toEqual(["task-1", "task-1"]);
  });
});
