// The checks the Concierge scheduled with `defer`: wake-ups of its chats,
// some for a task. A task's repeating schedule counts too: its next run is a
// check. A task with a pending check is "later" until it is due, stopping or
// archiving the task cancels its checks and its schedule, and a chat shows the
// checks pending in it, each of which its owner can cancel. Cancelling a
// schedule's check skips that one run.

import { RESUME_SESSION_ACTION } from "../routines/defer.js";
import type { RoutineEngine } from "../routines/engine.js";
import type { Routine } from "../routines/types.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import { createLogger } from "../logger.js";
import { CONCIERGE_TASK_RUN_ACTION, type TaskSchedules } from "./task-schedule.js";

const log = createLogger("concierge-task-checks");

/** A wake-up pending in a chat. Times are epoch milliseconds. */
export interface PendingCheck {
  id: string;
  name: string;
  /**
   * When it wakes the chat: its time, or the deadline of the event it waits
   * for. Infinity for an event wait with no deadline, sent as null.
   */
  at: number;
  /** What an event wait waits for, as `defer` labelled it; null for a timed one. */
  waitingFor: string | null;
  taskId: string | null;
  /** The next run of the task's repeating schedule; cancelling it skips that run only. */
  recurring?: true;
  /** When it was scheduled, epoch milliseconds. */
  createdAt?: number;
}

/**
 * A pending wake-up of a chat, or null for a routine that is none. A timed
 * one whose time passed is pending no more, unless `overdue` asks for it too,
 * as cancelling does: one still enabled fires as soon as Rome starts.
 */
function pendingCheckOf(
  routine: Routine,
  now: number,
  overdue = false,
): (PendingCheck & { chatId: string; owner: string }) | null {
  if (!routine.enabled || routine.actionName !== RESUME_SESSION_ACTION) return null;
  const args = (routine.args ?? {}) as Record<string, unknown>;
  if (args.channel !== "webchat" || typeof args.threadId !== "string") return null;
  const deadline = typeof args.deadline === "string" ? Date.parse(args.deadline) : Number.NaN;
  // An event wait from before deadlines has no time: it is pending until it fires.
  const at =
    routine.trigger.type === "event-bus"
      ? Number.isNaN(deadline)
        ? Number.POSITIVE_INFINITY
        : deadline
      : (routine.nextRunAt?.getTime() ?? Number.NaN);
  // A timed wake-up is pending until its time; one that fired is not.
  if (Number.isNaN(at) || (!overdue && routine.trigger.type !== "event-bus" && at <= now)) {
    return null;
  }
  return {
    id: routine.id,
    name: routine.name,
    at,
    waitingFor: typeof args.waitingFor === "string" ? args.waitingFor : null,
    taskId: typeof args.taskId === "string" ? args.taskId : null,
    createdAt: routine.createdAt.getTime(),
    chatId: args.threadId,
    // Whose chat scheduled it, as `defer` recorded it.
    owner: typeof args.ownerKey === "string" ? args.ownerKey : "guardian",
  };
}

/** Where a task stands: the Concierge chat it reports to, and whose it is. */
export interface TaskPlace {
  chatId: string;
  owner: string;
}

/**
 * The next run of a task's schedule, as a check of the chat the task reports
 * to, read from the task's row. A schedule whose task is gone has none.
 */
function scheduledRunOf(
  routine: Routine,
  at: number | null,
  place: TaskPlace | null,
): (PendingCheck & { chatId: string; owner: string }) | null {
  const taskId = (routine.args as Record<string, unknown> | null)?.taskId;
  if (typeof taskId !== "string" || !place || at === null) return null;
  return {
    id: routine.id,
    name: routine.name,
    at,
    waitingFor: null,
    taskId,
    recurring: true,
    createdAt: routine.createdAt.getTime(),
    chatId: place.chatId,
    owner: place.owner,
  };
}

export interface TaskChecksDeps {
  routines: Pick<RoutinesRepository, "listRoutines" | "deleteIfNoActiveRuns" | "update">;
  routineEngine: Pick<RoutineEngine, "deactivate" | "onChange" | "setFireGate">;
  /** A schedule's next run, and its skip when its check is cancelled. */
  schedules?: Pick<TaskSchedules, "skipNext" | "remove" | "nextRunOf">;
  /** Where each task stands, from its row; null for a task that is gone. */
  placeOf?: (taskId: string) => Promise<TaskPlace | null>;
  now?: () => number;
}

export class TaskChecks {
  private readonly now: () => number;

  /** Every routine, read once until one changes, so a task's status reads no table scan each time. */
  private routines: Promise<Routine[]> | null = null;

  constructor(private readonly deps: TaskChecksDeps) {
    this.now = deps.now ?? Date.now;
    deps.routineEngine.onChange(() => {
      this.routines = null;
    });
  }

  private readRoutines(): Promise<Routine[]> {
    this.routines ??= this.deps.routines.listRoutines().catch((error: unknown) => {
      this.routines = null;
      throw error;
    });
    return this.routines;
  }

  private async pending(
    overdue = false,
  ): Promise<Array<PendingCheck & { chatId: string; owner: string }>> {
    const now = this.now();
    const checks: Array<PendingCheck & { chatId: string; owner: string }> = [];
    for (const routine of await this.readRoutines()) {
      if (routine.actionName === CONCIERGE_TASK_RUN_ACTION) {
        if (!routine.enabled) continue;
        const taskId = (routine.args as Record<string, unknown> | null)?.taskId;
        const place =
          typeof taskId === "string" ? ((await this.deps.placeOf?.(taskId)) ?? null) : null;
        const at = (await this.deps.schedules?.nextRunOf(routine)) ?? null;
        const check = scheduledRunOf(routine, at, place);
        if (check) checks.push(check);
        continue;
      }
      const check = pendingCheckOf(routine, now, overdue);
      if (check) checks.push(check);
    }
    return checks;
  }

  /**
   * A check of a task that `ended` says is stopped or archived never wakes
   * its chat: when it fires, it is cancelled instead. Returns the release.
   */
  guardFires(ended: (taskId: string) => Promise<boolean>): () => void {
    this.deps.routineEngine.setFireGate(async (routine) => {
      if (routine.actionName !== RESUME_SESSION_ACTION) return true;
      const taskId = (routine.args as Record<string, unknown> | null)?.taskId;
      if (typeof taskId !== "string" || !(await ended(taskId))) return true;
      await this.remove(routine.id);
      return false;
    });
    return () => this.deps.routineEngine.setFireGate(null);
  }

  /** When each task's soonest pending check is due. */
  async laterOf(taskIds: readonly string[]): Promise<Map<string, number>> {
    const wanted = new Set(taskIds);
    const later = new Map<string, number>();
    if (wanted.size === 0) return later;
    for (const check of await this.pending()) {
      if (!check.taskId || !wanted.has(check.taskId)) continue;
      later.set(check.taskId, Math.min(check.at, later.get(check.taskId) ?? check.at));
    }
    return later;
  }

  /** How many checks were scheduled for each task, fired ones included. */
  async timesScheduled(taskIds: readonly string[]): Promise<Map<string, number>> {
    const wanted = new Set(taskIds);
    const counts = new Map<string, number>();
    for (const routine of await this.readRoutines()) {
      if (routine.actionName !== RESUME_SESSION_ACTION) continue;
      const taskId = (routine.args as Record<string, unknown> | null)?.taskId;
      if (typeof taskId !== "string" || !wanted.has(taskId)) continue;
      counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
    }
    return counts;
  }

  /** The tasks with a check that can still fire, one whose time passed included. */
  async pendingTaskIds(): Promise<string[]> {
    return [
      ...new Set(
        (await this.pending(true)).flatMap((check) => (check.taskId ? [check.taskId] : [])),
      ),
    ];
  }

  /** The checks pending in chat `chatId`, the soonest first. */
  async inChat(chatId: string): Promise<PendingCheck[]> {
    return (await this.pending())
      .filter((check) => check.chatId === chatId)
      .sort((a, b) => a.at - b.at)
      .map(({ chatId: _chat, owner: _owner, ...check }) => check);
  }

  /** A chat's pending checks as the API sends them: no time for a wait with none. */
  async inChatForApi(
    chatId: string,
  ): Promise<Array<Omit<PendingCheck, "at"> & { at: number | null }>> {
    return (await this.inChat(chatId)).map((check) => ({
      ...check,
      at: Number.isFinite(check.at) ? check.at : null,
    }));
  }

  /**
   * Cancels check `id` of chat `chatId`: a wake-up is removed, a schedule's
   * next run is skipped and the schedule stays. Answers whether there was one.
   */
  async cancel(chatId: string, id: string): Promise<boolean> {
    const check = (await this.pending()).find((found) => found.id === id);
    if (!check || check.chatId !== chatId) return false;
    if (check.recurring) {
      const routine = (await this.readRoutines()).find((found) => found.id === id);
      this.routines = null;
      return routine ? ((await this.deps.schedules?.skipNext(routine)) ?? false) : false;
    }
    await this.remove(id);
    return true;
  }

  /**
   * Cancels every check of task `taskId` that a chat of its owner `owner`
   * scheduled, as when it is stopped or archived. Answers how many.
   */
  async cancelFor(
    taskId: string,
    owner: string,
    options: { keepSchedule?: boolean } = {},
  ): Promise<number> {
    // One whose time passed is cancelled too: still enabled, it would fire.
    const checks = (await this.pending(true)).filter(
      (check) => check.taskId === taskId && check.owner === owner,
    );
    for (const check of checks) {
      // Cancelled from the task's row, a schedule only skips its next run.
      if (check.recurring && options.keepSchedule) {
        const routine = (await this.readRoutines()).find((found) => found.id === check.id);
        this.routines = null;
        if (routine) await this.deps.schedules?.skipNext(routine);
      } else if (check.recurring && this.deps.schedules) {
        this.routines = null;
        await this.deps.schedules.remove(taskId);
      } else await this.remove(check.id);
    }
    return checks.length;
  }

  private async remove(id: string): Promise<void> {
    this.routines = null;
    const result = await this.deps.routines.deleteIfNoActiveRuns(id);
    // A wake-up running now finishes; it is turned off so it never fires again.
    if (result.status === "active-runs") await this.deps.routines.update(id, { enabled: false });
    await this.deps.routineEngine.deactivate(id);
  }

  /**
   * Calls `changed` with each task whose pending check may have changed: one
   * was scheduled, fired or cancelled. Returns the unsubscribe.
   */
  watch(changed: (taskId: string) => void): () => void {
    // Every routine change reads the pending checks again, and tells the
    // tasks whose soonest check moved, came or went.
    let known = new Map<string, number>();
    let reading: Promise<void> = Promise.resolve();
    const read = async () => {
      const now = new Map<string, number>();
      for (const check of await this.pending()) {
        if (check.taskId)
          now.set(check.taskId, Math.min(check.at, now.get(check.taskId) ?? check.at));
      }
      for (const taskId of new Set([...known.keys(), ...now.keys()])) {
        if (known.get(taskId) !== now.get(taskId)) changed(taskId);
      }
      known = now;
    };
    reading = read().catch(() => undefined);
    return this.deps.routineEngine.onChange(() => {
      reading = reading.then(read).catch((error: unknown) =>
        log.warn("failed to read the pending checks", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }
}
