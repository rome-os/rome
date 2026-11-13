// A task's repeating schedule: every day, or on some weekdays, at a time in its
// owner's zone, its brief goes straight into its own task chat, with no
// Concierge turn. The work comes back the way any task's does. A schedule is a
// routine on the routine engine, one per task, keyed by the task's id
// (docs/adrs/scheduled-tasks.md).

import { AsyncLocalStorage } from "node:async_hooks";
import { Cron } from "croner";
import type { ActionRegistry } from "../apps/actions/types.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type { RoutineEngine } from "../routines/engine.js";
import type { Routine, ScheduleTrigger } from "../routines/types.js";
import { toRoutine } from "../db/repositories/routines.js";
import { createLogger } from "../logger.js";
import type { ConciergeOwner } from "../webchat/owner.js";

const log = createLogger("concierge-task-schedule");

/** The action a task's schedule fires. Internal: not agent-callable. */
export const CONCIERGE_TASK_RUN_ACTION = "core:concierge_task_run";

/** The key of task `taskId`'s schedule routine. */
export const taskScheduleKey = (taskId: string) => `concierge-task-schedule:${taskId}`;

export const SCHEDULE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number];

/** Whether each run is reported, or only one that needs the owner or failed. */
export const SCHEDULE_REPORTS = ["every_run", "when_it_matters"] as const;
export type ScheduleReport = (typeof SCHEDULE_REPORTS)[number];

/** When a task runs, and what each run sends and reports. */
export interface TaskSchedule {
  /** Local time in the owner's zone, "HH:MM". */
  at: string;
  /** The weekdays it runs on; every day when absent. */
  days?: ScheduleWeekday[];
  report: ScheduleReport;
  /** What each run sends into the task chat. */
  brief: string;
  /** The skill each run's brief is sent with, by name. */
  skill?: string;
}

/** A task's schedule as the Concierge reads it back. */
export interface TaskScheduleView extends TaskSchedule {
  /** The next run, epoch milliseconds, past a skipped one; null when none is due. */
  nextRunAt: number | null;
}

const RRULE_DAY: Record<ScheduleWeekday, string> = {
  mon: "MO",
  tue: "TU",
  wed: "WE",
  thu: "TH",
  fri: "FR",
  sat: "SA",
  sun: "SU",
};
const CRON_DAY: Record<ScheduleWeekday, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Reads a schedule from a tool's arguments: an object sets it, null removes
 * it. `brief` is the one to keep when the object leaves it out. Throws a
 * message the Concierge can act on.
 */
export function parseTaskSchedule(raw: unknown, brief: string | undefined): TaskSchedule | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('schedule must be an object such as { "at": "12:25" }, or null to remove it');
  }
  const value = raw as Record<string, unknown>;
  const at = typeof value.at === "string" ? value.at.trim() : "";
  const match = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error('schedule.at must be a local time "HH:MM", such as "12:25"');
  }
  let days: ScheduleWeekday[] | undefined;
  if (value.days !== undefined && value.days !== null) {
    if (!Array.isArray(value.days) || value.days.length === 0) {
      throw new Error(`schedule.days must list weekdays: ${SCHEDULE_WEEKDAYS.join(", ")}`);
    }
    const unknown = value.days.filter(
      (day) => typeof day !== "string" || !SCHEDULE_WEEKDAYS.includes(day as ScheduleWeekday),
    );
    if (unknown.length > 0) {
      throw new Error(
        `schedule.days takes ${SCHEDULE_WEEKDAYS.join(", ")}, not ${unknown.join(", ")}`,
      );
    }
    days = SCHEDULE_WEEKDAYS.filter((day) => (value.days as unknown[]).includes(day));
    if (days.length === SCHEDULE_WEEKDAYS.length) days = undefined;
  }
  const report = value.report ?? "every_run";
  if (typeof report !== "string" || !SCHEDULE_REPORTS.includes(report as ScheduleReport)) {
    throw new Error(`schedule.report must be ${SCHEDULE_REPORTS.join(" or ")}`);
  }
  const ownBrief = typeof value.brief === "string" ? value.brief.trim() : "";
  const kept = ownBrief || brief?.trim() || "";
  if (!kept) throw new Error("schedule.brief is required: what each run asks the task chat");
  const [hour, minute] = at.split(":");
  return {
    at: `${hour.padStart(2, "0")}:${minute}`,
    ...(days ? { days } : {}),
    report: report as ScheduleReport,
    brief: kept,
  };
}

function triggerOf(schedule: TaskSchedule, tzid: string, floating: boolean): ScheduleTrigger {
  return {
    type: "schedule",
    tzid,
    tzMode: floating ? "floating" : "fixed",
    localTime: schedule.at,
    rrule: schedule.days
      ? `FREQ=WEEKLY;BYDAY=${schedule.days.map((day) => RRULE_DAY[day]).join(",")}`
      : "FREQ=DAILY",
  };
}

/** The schedule a routine holds, or null for a routine that is no task's schedule. */
export function scheduleOfRoutine(routine: Routine): (TaskSchedule & { taskId: string }) | null {
  if (routine.actionName !== CONCIERGE_TASK_RUN_ACTION || routine.trigger.type !== "schedule") {
    return null;
  }
  const args = routine.args as Record<string, unknown>;
  if (typeof args.taskId !== "string" || typeof args.brief !== "string") return null;
  const byDay = /BYDAY=([A-Z,]+)/.exec(routine.trigger.rrule?.toUpperCase() ?? "")?.[1];
  const days = byDay
    ? SCHEDULE_WEEKDAYS.filter((day) => byDay.split(",").includes(RRULE_DAY[day]))
    : undefined;
  return {
    taskId: args.taskId,
    at: routine.trigger.localTime,
    ...(days ? { days } : {}),
    report: args.report === "when_it_matters" ? "when_it_matters" : "every_run",
    brief: args.brief,
    ...(typeof args.skill === "string" && args.skill ? { skill: args.skill } : {}),
  };
}

/** The runs the owner skipped that have not fired yet, as epoch milliseconds. */
function skipsOf(routine: Routine): number[] {
  const skips = (routine.args as Record<string, unknown>).skips;
  if (!Array.isArray(skips)) return [];
  return skips
    .map((skip) => (typeof skip === "string" ? Date.parse(skip) : Number.NaN))
    .filter((at) => !Number.isNaN(at));
}

/** A schedule routine's args with skips `skips`, none when the list is empty. */
function withSkips(routine: Routine, skips: number[]): Record<string, unknown> {
  const { skips: _old, ...args } = routine.args as Record<string, unknown>;
  return skips.length === 0
    ? args
    : { ...args, skips: skips.map((at) => new Date(at).toISOString()) };
}

export interface TaskSchedulesDeps {
  routines: Pick<
    RoutinesRepository,
    "create" | "update" | "findByKey" | "findById" | "deleteIfNoActiveRuns" | "listRoutines"
  >;
  routineEngine: Pick<RoutineEngine, "activate" | "deactivate">;
  /** The owner's time zone. */
  timezoneOf: (owner: ConciergeOwner) => Promise<string>;
  /** The zone a floating schedule fires in now, as the schedule trigger resolves it. */
  floatingZone: () => Promise<string>;
  /** Whose task `taskId` is, from its row; null for a task that is gone. */
  ownerOf: (taskId: string) => Promise<ConciergeOwner | null>;
}

/** Each task's schedule: written, read back, skipped once, removed. */
export class TaskSchedules {
  constructor(private readonly deps: TaskSchedulesDeps) {}

  /** Sets task `taskId`'s schedule, replacing any it had. */
  async set(
    task: { id: string; title: string; owner: ConciergeOwner },
    schedule: TaskSchedule,
  ): Promise<void> {
    // The guardian's floats with the guardian's zone, as every floating
    // routine does; a visitor's is fixed to their own.
    const floating = task.owner === "guardian";
    const trigger = triggerOf(schedule, await this.deps.timezoneOf(task.owner), floating);
    // The task is the one source of truth for where a run goes: its task
    // chat and the Concierge chat it reports to are read from its row.
    const args = {
      taskId: task.id,
      report: schedule.report,
      brief: schedule.brief,
      ...(schedule.skill ? { skill: schedule.skill } : {}),
    };
    const key = taskScheduleKey(task.id);
    const existing = await this.deps.routines.findByKey(key);
    const id = existing
      ? existing.id
      : await this.deps.routines.create({
          // The task list names the run by it.
          name: task.title,
          key,
          trigger,
          actionName: CONCIERGE_TASK_RUN_ACTION,
          args,
          // A run acts for the person the task is for.
          createdBy: { owner: task.owner },
          // The task's row says where it reports, which can move.
          chatId: null,
        });
    if (existing) {
      await this.deps.routines.update(id, { name: task.title, trigger, args, enabled: true });
    }
    await this.reactivate(id);
  }

  /**
   * Moves owner `owner`'s fixed schedules to their new zone `timezone`, so
   * each still runs at its local time there. The guardian's float, and follow
   * their zone on their own.
   */
  async rezone(owner: ConciergeOwner, timezone: string): Promise<void> {
    for (const routine of await this.deps.routines.listRoutines()) {
      const trigger = routine.trigger;
      const taskId = (routine.args as Record<string, unknown>).taskId;
      if (
        routine.actionName !== CONCIERGE_TASK_RUN_ACTION ||
        trigger.type !== "schedule" ||
        trigger.tzMode !== "fixed" ||
        trigger.tzid === timezone ||
        typeof taskId !== "string" ||
        (await this.deps.ownerOf(taskId)) !== owner
      ) {
        continue;
      }
      await this.deps.routines.update(routine.id, { trigger: { ...trigger, tzid: timezone } });
      await this.reactivate(routine.id);
    }
  }

  /** Removes task `taskId`'s schedule. Answers whether it had one. */
  async remove(taskId: string): Promise<boolean> {
    const routine = await this.deps.routines.findByKey(taskScheduleKey(taskId));
    if (!routine) return false;
    const result = await this.deps.routines.deleteIfNoActiveRuns(routine.id);
    // A run going on now finishes; the schedule never fires again.
    if (result.status === "active-runs") {
      await this.deps.routines.update(routine.id, { enabled: false });
    }
    await this.deps.routineEngine.deactivate(routine.id);
    return true;
  }

  /**
   * Skips the next run of the schedule routine `routine` that is not skipped
   * already; the one after runs. Each skip holds until its own run fires.
   */
  async skipNext(routine: Routine): Promise<boolean> {
    const next = await this.nextRunOf(routine);
    if (next === null) return false;
    // A skip whose run is gone by is dropped.
    const firing = routine.nextRunAt?.getTime() ?? next;
    const kept = skipsOf(routine).filter((at) => at >= firing);
    await this.deps.routines.update(routine.id, { args: withSkips(routine, [...kept, next]) });
    await this.reactivate(routine.id);
    return true;
  }

  /** Task `taskId`'s schedule, or null when it has none. */
  async of(taskId: string): Promise<TaskScheduleView | null> {
    const routine = await this.deps.routines.findByKey(taskScheduleKey(taskId));
    if (!routine?.enabled) return null;
    const schedule = scheduleOfRoutine(routine);
    if (!schedule) return null;
    const { taskId: _task, ...view } = schedule;
    return { ...view, nextRunAt: await this.nextRunOf(routine) };
  }

  /**
   * When schedule routine `routine` runs next: the run the engine has stored,
   * or, past the runs its owner skipped, the first one after them, in the
   * zone the schedule trigger fires in. Null when it has no run to come.
   */
  async nextRunOf(routine: Routine): Promise<number | null> {
    if (!routine.enabled || routine.trigger.type !== "schedule") return null;
    let next = routine.nextRunAt?.getTime() ?? null;
    const skips = new Set(skipsOf(routine));
    if (next === null || !skips.has(next)) return next;
    const schedule = scheduleOfRoutine(routine);
    if (!schedule) return null;
    const zone =
      routine.trigger.tzMode === "fixed" ? routine.trigger.tzid : await this.deps.floatingZone();
    const [hour, minute] = schedule.at.split(":").map(Number);
    const days = schedule.days ? schedule.days.map((day) => CRON_DAY[day]).join(",") : "*";
    const cron = new Cron(`${minute} ${hour} * * ${days}`, { timezone: zone });
    // Each skip is one run, so the walk ends within as many steps.
    for (let step = 0; next !== null && skips.has(next) && step <= skips.size; step++) {
      next = cron.nextRun(new Date(next))?.getTime() ?? null;
    }
    return next;
  }

  /**
   * Whether a fire at `firedAt` of task `taskId`'s schedule is a run its
   * owner skipped. While a fire runs, the engine's stored next run is the
   * one firing, so a late fire still matches its skip. A skipped run is let
   * go, and the next one runs; its skip, and any whose run passed, are
   * dropped.
   */
  async takeSkip(taskId: string, firedAt: number): Promise<boolean> {
    const routine = await this.deps.routines.findByKey(taskScheduleKey(taskId));
    const firing = routine?.nextRunAt?.getTime() ?? null;
    if (!routine || firing === null) return false;
    const skips = skipsOf(routine);
    // A run started by hand before its time is no scheduled fire.
    if (skips.length === 0 || firedAt < firing - 60_000) return false;
    const later = skips.filter((at) => at > firing);
    if (later.length !== skips.length) {
      await this.deps.routines.update(routine.id, { args: withSkips(routine, later) });
    }
    return skips.includes(firing);
  }

  private async reactivate(id: string): Promise<void> {
    await this.deps.routineEngine.deactivate(id);
    const row = await this.deps.routines.findById(id);
    if (row?.enabled) await this.deps.routineEngine.activate(toRoutine(row));
    else log.warn("a task's schedule is off and was not activated", { routineId: id });
  }
}

/**
 * Registers the action a task's schedule fires. It sends the run through the
 * Concierge's `runScheduledTask`; it is internal, never agent-callable.
 */
export function registerTaskRunAction(
  actions: Pick<ActionRegistry, "register">,
  concierge: { runScheduledTask(taskId: string, firedAt: number): Promise<string> },
  now: () => number = Date.now,
): void {
  // The action runs in main, inside its execution's async context, which may
  // not call other actions. The run starts the task chat's turn, whose agent
  // calls actions, so it runs in the context of boot instead.
  const outsideAction = AsyncLocalStorage.snapshot();
  actions.register({
    config: {
      name: CONCIERGE_TASK_RUN_ACTION,
      type: "system",
      description:
        "Internal: sends a scheduled task's brief into its task chat. Fired by the task's schedule; not agent-callable.",
      // Explicit: no agent's allow-list names it.
      visibility: "explicit",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    execute: async (args) => {
      const taskId = (args as Record<string, unknown>).taskId;
      if (typeof taskId !== "string") {
        return { status: "error", error: `${CONCIERGE_TASK_RUN_ACTION} needs a taskId` };
      }
      try {
        return {
          status: "ok",
          data: { run: await outsideAction(() => concierge.runScheduledTask(taskId, now())) },
        };
      } catch (error) {
        return { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
