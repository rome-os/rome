import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { ScheduleTriggerProvider } from "../routines/schedule-trigger-provider.js";
import type { Routine } from "../routines/types.js";
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
  // The zone the guardian's floating schedules fire in now.
  let zone: string;
  let provider: ScheduleTriggerProvider;

  beforeEach(() => {
    rs.useFakeTimers({ shouldAdvanceTime: false });
    rs.setSystemTime(new Date(NOW));
    testDb = createTestDb();
    routines = new RoutinesRepository(testDb.db);
    active = new Set();
    zone = "Asia/Shanghai";
    // The real schedule trigger, so each schedule's next run is stored as
    // the engine stores it; no fire happens while the clock stands still.
    provider = new ScheduleTriggerProvider(routines, async () => zone);
    // As the engine: a fire tells its listeners when it ends, and again once
    // the trigger has stored the next run.
    const listeners = new Set<(routineId: string) => void>();
    const changed = (routineId: string) => {
      for (const listener of listeners) listener(routineId);
    };
    const routineEngine = {
      activate: async (routine: Routine) => {
        active.add(routine.id);
        await provider.activate(
          routine,
          async () => changed(routine.id),
          () => changed(routine.id),
        );
      },
      deactivate: async (id: string) => {
        active.delete(id);
        provider.deactivate(id);
      },
      onChange: (listener: (routineId: string) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      setFireGate: () => {},
    };
    schedules = new TaskSchedules({
      routines,
      routineEngine,
      timezoneOf: async (owner) => (owner === "guardian" ? "Asia/Shanghai" : "UTC"),
      floatingZone: async () => zone,
      ownerOf: async (taskId) =>
        taskId === "task-1" ? "guardian" : taskId === "task-2" ? "visitor:a" : null,
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
  afterEach(() => {
    for (const id of active) provider.deactivate(id);
    rs.useRealTimers();
    testDb.close();
  });

  const task = { id: "task-1", title: "Daily summary", owner: "guardian" };
  /** The engine re-activating floating schedules after the guardian's zone changed. */
  const moveTo = async (newZone: string) => {
    zone = newZone;
    for (const routine of await routines.listRoutines()) {
      await provider.activate(routine, async () => {});
    }
  };

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

  it("follows the guardian's zone as the engine does, and skips the run that really fires", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "b" });
    await moveTo("Europe/London");

    // 12:25 in London today, not in the zone the schedule was set in.
    expect(await schedules.of("task-1")).toMatchObject({ nextRunAt: at(12, 12, 25) });
    const [check] = await checks.inChat("concierge");
    expect(check).toMatchObject({ at: at(12, 12, 25) });
    expect(await checks.cancel("concierge", check!.id)).toBe(true);
    expect(await checks.inChat("concierge")).toMatchObject([{ at: at(13, 12, 25) }]);
    expect(await schedules.takeSkip("task-1", at(12, 12, 25))).toBe(true);
  });

  it("keeps the check and its skip on the engine's fire when the zone moves from UTC to Los Angeles", async () => {
    zone = "UTC";
    await schedules.set(task, { at: "08:00", report: "every_run", brief: "b" });
    await moveTo("America/Los_Angeles");
    const engineNext = async () =>
      (await routines.findByKey(taskScheduleKey("task-1")))?.nextRunAt?.getTime();

    // 08:00 in Los Angeles is 16:00 UTC, still to come today.
    expect(await engineNext()).toBe(at(12, 16));
    const [check] = await checks.inChat("concierge");
    expect(check?.at).toBe(await engineNext());
    await checks.cancel("concierge", check!.id);
    expect((await routines.findByKey(taskScheduleKey("task-1")))?.args).toMatchObject({
      skips: [new Date(at(12, 16)).toISOString()],
    });
    expect(await checks.inChat("concierge")).toMatchObject([{ at: at(13, 16) }]);
    expect(await schedules.takeSkip("task-1", at(12, 16))).toBe(true);
  });

  it("skips every run cancelled before the first of them fires", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "b" });
    const cancelNext = async () => {
      const [check] = await checks.inChat("concierge");
      expect(await checks.cancel("concierge", check!.id)).toBe(true);
    };
    await cancelNext();
    await cancelNext();
    expect(await checks.inChat("concierge")).toMatchObject([{ at: at(15, 4, 25) }]);

    // The engine fires each day in turn, moving its next run on after each.
    const id = (await routines.findByKey(taskScheduleKey("task-1")))!.id;
    expect(await schedules.takeSkip("task-1", at(13, 4, 25))).toBe(true);
    await routines.updateNextRun(id, new Date(at(14, 4, 25)));
    expect(await schedules.takeSkip("task-1", at(14, 4, 25))).toBe(true);
    await routines.updateNextRun(id, new Date(at(15, 4, 25)));
    expect(await schedules.takeSkip("task-1", at(15, 4, 25))).toBe(false);
  });

  it("shows the next run once a run fired, and a cancel then skips that one", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "b" });
    // The task list watches the checks, reading them on every change.
    const stop = checks.watch(() => {});
    try {
      // The 12:25 fire: the clock reaches it, and the trigger's timer runs.
      rs.setSystemTime(new Date(at(13, 4, 25) + 1_000));
      await rs.runOnlyPendingTimersAsync();

      const [check] = await checks.inChat("concierge");
      expect(check).toMatchObject({ at: at(14, 4, 25) });
      await checks.cancel("concierge", check!.id);
      expect((await routines.findByKey(taskScheduleKey("task-1")))?.args).toMatchObject({
        skips: [new Date(at(14, 4, 25)).toISOString()],
      });
    } finally {
      stop();
    }
  });

  it("honours a skip when its fire comes late, and keeps it through a run by hand", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "b" });
    const [check] = await checks.inChat("concierge");
    await checks.cancel("concierge", check!.id);

    // A run started by hand before its time is no scheduled fire.
    expect(await schedules.takeSkip("task-1", NOW)).toBe(false);
    // The host slept, and the 12:25 fire came five minutes late.
    expect(await schedules.takeSkip("task-1", at(13, 4, 30))).toBe(true);
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

  it("stores a schedule's skill, and reads it back for each run", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "b", skill: "s:x" });
    expect((await routines.findByKey(taskScheduleKey("task-1")))?.args).toMatchObject({
      skill: "s:x",
    });
    expect(await schedules.of("task-1")).toMatchObject({ brief: "b", skill: "s:x" });
  });

  it("moves a visitor's schedule to their new zone, so it keeps its local time", async () => {
    await schedules.set(task, { at: "12:25", report: "every_run", brief: "b" });
    await schedules.set(
      { id: "task-2", title: "Morning", owner: "visitor:a" },
      { at: "07:30", report: "every_run", brief: "b" },
    );
    await schedules.rezone("visitor:a", "Asia/Tokyo");

    const visitors = await routines.findByKey(taskScheduleKey("task-2"));
    expect(visitors?.trigger).toMatchObject({ tzid: "Asia/Tokyo", tzMode: "fixed" });
    // 07:30 in Tokyo is 22:30 UTC the day before.
    expect(visitors?.nextRunAt?.getTime()).toBe(at(12, 22, 30));
    // The guardian's floats, and is left alone.
    expect((await routines.findByKey(taskScheduleKey("task-1")))?.trigger).toMatchObject({
      tzid: "Asia/Shanghai",
      tzMode: "floating",
    });
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

describe("a task's scheduled run on the action engine", () => {
  it("runs in main, where the Concierge is, and lets the turn it starts call actions", async () => {
    const registry = new ActionRegistryImpl();
    const runs: unknown[] = [];
    // The run starts the task chat's turn, whose agent calls actions of its own.
    registerTaskRunAction(registry, {
      runScheduledTask: async (taskId) => {
        runs.push(taskId, await engine.run("system:send_message", {}));
        return "sent";
      },
    });
    registry.register({
      config: {
        name: "system:send_message",
        type: "system",
        description: "Sends a message.",
        complexity: "simple",
        speed: "fast",
        reliability: "high",
        sideEffects: "write",
      },
      execute: async () => ({ status: "ok", data: "sent-in-main" }),
    });
    // No worker to fork: a root that left main would fail.
    const engine = new ActionEngine(registry, createActionEngineRepos(), {
      processRole: "main",
      workerWarmPoolSize: 0,
      isFirstPartyAction: () => true,
    });

    await expect(engine.run(CONCIERGE_TASK_RUN_ACTION, { taskId: "task-1" })).resolves.toEqual({
      status: "ok",
      data: { run: "sent" },
    });
    expect(runs).toEqual(["task-1", { status: "ok", data: "sent-in-main" }]);
  });
});
