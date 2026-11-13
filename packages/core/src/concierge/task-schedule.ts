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
  };
}

/**
 * When a schedule routine runs next, past the run its owner skipped: an
 * epoch time, or null when it has no run to come.
 */
export function nextScheduledRun(routine: Routine, now: number): number | null {
  if (!routine.enabled || routine.trigger.type !== "schedule") return null;
  const schedule = scheduleOfRoutine(routine);
  if (!schedule) return null;
  const [hour, minute] = schedule.at.split(":").map(Number);
  const days = schedule.days ? schedule.days.map((day) => CRON_DAY[day]).join(",") : "*";
  const cron = new Cron(`${minute} ${hour} * * ${days}`, { timezone: routine.trigger.tzid });
  const skipAt = skipOf(routine);
  // The run the engine has next, unless it is gone by or skipped.
  let from = new Date(now);
  for (let i = 0; i < 2; i++) {
    const next = cron.nextRun(from);
    if (!next) return null;
    if (skipAt === null || Math.abs(next.getTime() - skipAt) > 60_000) return next.getTime();
    from = next;
  }
  return null;
}

/** The run the owner skipped, as epoch milliseconds, or null. */
function skipOf(routine: Routine): number | null {
  const skip = (routine.args as Record<string, unknown>).skipAt;
  const at = typeof skip === "string" ? Date.parse(skip) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

export interface TaskSchedulesDeps {
  routines: Pick<
    RoutinesRepository,
    "create" | "update" | "findByKey" | "findById" | "deleteIfNoActiveRuns"
  >;
  routineEngine: Pick<RoutineEngine, "activate" | "deactivate">;
  /** The owner's time zone. */
  timezoneOf: (owner: ConciergeOwner) => Promise<string>;
  now?: () => number;
}

/** Each task's schedule: written, read back, skipped once, removed. */
export class TaskSchedules {
  private readonly now: () => number;

  constructor(private readonly deps: TaskSchedulesDeps) {
    this.now = deps.now ?? Date.now;
  }

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
    const args = { taskId: task.id, report: schedule.report, brief: schedule.brief };
    const key = taskScheduleKey(task.id);
    const existing = await this.deps.routines.findByKey(key);
    const id = existing
      ? existing.id
      : await this.deps.routines.create({
          // The chat's check strip names the run by it.
          name: task.title,
          key,
          trigger,
          actionName: CONCIERGE_TASK_RUN_ACTION,
          args,
          // A run acts for the person the task is for.
          createdBy: { owner: task.owner },
        });
    if (existing) {
      await this.deps.routines.update(id, { name: task.title, trigger, args, enabled: true });
    }
    await this.reactivate(id);
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

  /** Skips the next run of the schedule routine `routine`; the one after runs. */
  async skipNext(routine: Routine): Promise<boolean> {
    const next = nextScheduledRun(routine, this.now());
    if (next === null) return false;
    await this.deps.routines.update(routine.id, {
      args: { ...routine.args, skipAt: new Date(next).toISOString() },
    });
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
    return { ...view, nextRunAt: nextScheduledRun(routine, this.now()) };
  }

  /**
   * Whether a fire at `firedAt` of task `taskId`'s schedule is the run its
   * owner skipped. A skipped run is let go, and the next one runs.
   */
  async takeSkip(taskId: string, firedAt: number): Promise<boolean> {
    const routine = await this.deps.routines.findByKey(taskScheduleKey(taskId));
    const skipAt = routine ? skipOf(routine) : null;
    if (!routine || skipAt === null) return false;
    // A skip is for one run: the one at its time. One past it is cleared.
    if (firedAt < skipAt - 60_000) return false;
    const { skipAt: _skip, ...args } = routine.args as Record<string, unknown>;
    await this.deps.routines.update(routine.id, { args });
    return Math.abs(firedAt - skipAt) <= 60_000;
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
