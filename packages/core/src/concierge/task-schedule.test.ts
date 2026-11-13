import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { TaskChecks } from "./task-checks.js";
import {
  CONCIERGE_TASK_RUN_ACTION,
  parseTaskSchedule,
  registerTaskRunAction,
  TaskSchedules,
  taskScheduleKey,
} from "./task-schedule.js";
import type { Action } from "@rome-os/app-runtime";

// Thursday 12 November 2026, 09:00 UTC.
const NOW = Date.UTC(2026, 10, 12, 9);
const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour, minute);

describe("parseTaskSchedule", () => {
  it("reads a daily time, weekdays and the report, keeping the given brief", () => {
    expect(parseTaskSchedule({ at: "9:05" }, "Sum up my day")).toEqual({
      at: "09:05",
      report: "every_run",
      brief: "Sum up my day",
    });
    expect(
      parseTaskSchedule(
        { at: "12:25", days: ["fri", "mon"], report: "when_it_matters", brief: "Own" },
        "Kept",
      ),
    ).toEqual({ at: "12:25", days: ["mon", "fri"], report: "when_it_matters", brief: "Own" });
    // Every weekday named is every day.
    expect(
      parseTaskSchedule(
        { at: "08:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
        "b",
      )?.days,
    ).toBeUndefined();
    expect(parseTaskSchedule(null, "b")).toBeNull();
  });

  it("refuses what it cannot run, saying what to pass", () => {
    expect(() => parseTaskSchedule({ at: "25:00" }, "b")).toThrow(/HH:MM/);
    expect(() => parseTaskSchedule({ at: "12:25", days: ["someday"] }, "b")).toThrow(/someday/);
    expect(() => parseTaskSchedule({ at: "12:25", report: "always" }, "b")).toThrow(/report/);
    expect(() => parseTaskSchedule({ at: "12:25" }, undefined)).toThrow(/brief/);
    expect(() => parseTaskSchedule("daily", "b")).toThrow(/object/);
  });
});

describe("TaskSchedules", () => {
  let testDb: TestDb;
  let routines: RoutinesRepository;
  let schedules: TaskSchedules;
  let checks: TaskChecks;
  let active: Set<string>;

  beforeEach(() => {
    testDb = createTestDb();
    routines = new RoutinesRepository(testDb.db);
    active = new Set();
    const routineEngine = {
      activate: async (routine: { id: string }) => void active.add(routine.id),
      deactivate: async (id: string) => void active.delete(id),
      onChange: () => () => {},
    };
    schedules = new TaskSchedules({
      routines,
      routineEngine,
      timezoneOf: async (owner) => (owner === "guardian" ? "Asia/Shanghai" : "UTC"),
      now: () => NOW,
    });
    checks = new TaskChecks({
      routines,
      routineEngine,
      schedules,
      // The task's row says where it reports, never its schedule.
      placeOf: async (taskId) =>
        taskId === "task-1" ? { chatId: "concierge", owner: "guardian" } : null,
      now: () => NOW,
    });
  });
  afterEach(() => testDb.close());

  const task = { id: "task-1", title: "Daily summary", owner: "guardian" };

  it("keeps one routine per task, in the owner's zone, and reads it back", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "Sum up my day" });
    await schedules.set(task, {
      at: "12:25",
      days: ["mon", "fri"],
      report: "when_it_matters",
      brief: "Sum up my week",
    });

    const routine = await routines.findByKey(taskScheduleKey("task-1"));
    expect((await routines.listRoutines()).length).toBe(1);
    expect(routine).toMatchObject({
      actionName: CONCIERGE_TASK_RUN_ACTION,
      enabled: true,
      trigger: {
        type: "schedule",
        tzid: "Asia/Shanghai",
        tzMode: "floating",
        localTime: "12:25",
        rrule: "FREQ=WEEKLY;BYDAY=MO,FR",
      },
    });
    // Only the task: its chats are read from its row.
    expect(routine?.args).toEqual({
      taskId: "task-1",
      report: "when_it_matters",
      brief: "Sum up my week",
    });
    expect(active.has(routine!.id)).toBe(true);
    // Friday 13 November, 12:25 in Shanghai.
    expect(await schedules.of("task-1")).toEqual({
      at: "12:25",
      days: ["mon", "fri"],
      report: "when_it_matters",
      brief: "Sum up my week",
      nextRunAt: at(13, 4, 25),
    });
  });

  it("shows the next run as the task's check, so it reads later until then", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "b" });

    expect(await checks.laterOf(["task-1"])).toEqual(new Map([["task-1", at(13, 4, 25)]]));
    expect(await checks.inChat("concierge")).toMatchObject([
      { taskId: "task-1", at: at(13, 4, 25), recurring: true },
    ]);
    // A schedule's runs are no checks the Concierge put off.
    expect(await checks.timesScheduled(["task-1"])).toEqual(new Map());
  });

  it("skips only the next run when its check is cancelled, then runs again", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "b" });
    const [check] = await checks.inChat("concierge");

    expect(await checks.cancel("concierge", check!.id)).toBe(true);
    expect(await checks.inChat("concierge")).toMatchObject([{ at: at(14, 4, 25) }]);
    // The skipped fire sends nothing and clears the skip; the next one runs.
    expect(await schedules.takeSkip("task-1", at(13, 4, 25))).toBe(true);
    expect(await schedules.takeSkip("task-1", at(14, 4, 25))).toBe(false);
    expect(await schedules.of("task-1")).toMatchObject({ nextRunAt: at(13, 4, 25) });
  });

  it("removes the schedule when the task's checks are cancelled, as a stop does", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "b" });

    expect(await checks.cancelFor("task-1", "guardian")).toBe(1);
    expect(await schedules.of("task-1")).toBeNull();
    expect(await routines.listRoutines()).toEqual([]);
    expect(await schedules.remove("task-1")).toBe(false);
  });

  it("skips only the next run when the task's checks are cancelled from its row", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "b" });

    expect(await checks.cancelFor("task-1", "guardian", { keepSchedule: true })).toBe(1);
    expect(await checks.inChat("concierge")).toMatchObject([
      { at: at(14, 4, 25), recurring: true },
    ]);
  });

  it("shows no check for a schedule whose task is gone", async () => {
    await schedules.set(
      { id: "gone", title: "Gone", owner: "guardian" },
      {
        at: "12:25",
        report: "every_run",
        brief: "b",
      },
    );
    expect(await checks.laterOf(["gone"])).toEqual(new Map());
  });

  it("fixes a visitor's schedule to their own zone", async () => {
    await schedules.set(
      { id: "task-2", title: "Morning", owner: "visitor:a" },
      { at: "07:30", report: "every_run", brief: "b" },
    );
    expect((await routines.findByKey(taskScheduleKey("task-2")))?.trigger).toMatchObject({
      tzid: "UTC",
      tzMode: "fixed",
      rrule: "FREQ=DAILY",
    });
  });
});

describe("registerTaskRunAction", () => {
  it("runs the task's scheduled run and reports how it went", async () => {
    let action: Action | undefined;
    const runs: Array<[string, number]> = [];
    registerTaskRunAction(
      { register: (registered) => void (action = registered) },
      {
        runScheduledTask: async (taskId, firedAt) => {
          runs.push([taskId, firedAt]);
          return "sent";
        },
      },
      () => NOW,
    );

    expect(action?.config).toMatchObject({
      name: CONCIERGE_TASK_RUN_ACTION,
      visibility: "explicit",
    });
    expect(await action!.execute({ taskId: "task-1" }, {} as never)).toEqual({
      status: "ok",
      data: { run: "sent" },
    });
    expect(runs).toEqual([["task-1", NOW]]);
    expect(await action!.execute({}, {} as never)).toMatchObject({ status: "error" });
  });
});
