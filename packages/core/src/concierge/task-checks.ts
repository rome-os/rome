// The checks the Concierge scheduled with `defer`: wake-ups of its chats,
// some for a task. A task with a pending check is "later" until it is due,
// stopping or archiving the task cancels its checks, and a chat shows the
// checks pending in it, each of which its owner can cancel.

import { RESUME_SESSION_ACTION } from "../routines/defer.js";
import type { RoutineEngine } from "../routines/engine.js";
import type { Routine } from "../routines/types.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-task-checks");

/** A wake-up pending in a chat. Times are epoch milliseconds. */
export interface PendingCheck {
  id: string;
  name: string;
  /** When it wakes the chat: its time, or the deadline of the event it waits for. */
  at: number;
  /** What an event wait waits for, as `defer` labelled it; null for a timed one. */
  waitingFor: string | null;
  taskId: string | null;
}

/** A pending wake-up of a chat, or null for a routine that is none. */
function pendingCheckOf(routine: Routine, now: number): (PendingCheck & { chatId: string }) | null {
  if (!routine.enabled || routine.actionName !== RESUME_SESSION_ACTION) return null;
  const args = (routine.args ?? {}) as Record<string, unknown>;
  if (args.channel !== "webchat" || typeof args.threadId !== "string") return null;
  const deadline = typeof args.deadline === "string" ? Date.parse(args.deadline) : Number.NaN;
  const at =
    routine.trigger.type === "event-bus" ? deadline : (routine.nextRunAt?.getTime() ?? Number.NaN);
  // A timed wake-up is pending until its time; one that fired is not.
  if (Number.isNaN(at) || (routine.trigger.type !== "event-bus" && at <= now)) return null;
  return {
    id: routine.id,
    name: routine.name,
    at,
    waitingFor: typeof args.waitingFor === "string" ? args.waitingFor : null,
    taskId: typeof args.taskId === "string" ? args.taskId : null,
    chatId: args.threadId,
  };
}

export interface TaskChecksDeps {
  routines: Pick<RoutinesRepository, "listRoutines" | "deleteIfNoActiveRuns" | "update">;
  routineEngine: Pick<RoutineEngine, "deactivate" | "onChange">;
  now?: () => number;
}

export class TaskChecks {
  private readonly now: () => number;

  constructor(private readonly deps: TaskChecksDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async pending(): Promise<Array<PendingCheck & { chatId: string }>> {
    const now = this.now();
    return (await this.deps.routines.listRoutines()).flatMap((routine) => {
      const check = pendingCheckOf(routine, now);
      return check ? [check] : [];
    });
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
    for (const routine of await this.deps.routines.listRoutines()) {
      if (routine.actionName !== RESUME_SESSION_ACTION) continue;
      const taskId = (routine.args as Record<string, unknown> | null)?.taskId;
      if (typeof taskId !== "string" || !wanted.has(taskId)) continue;
      counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
    }
    return counts;
  }

  /** The checks pending in chat `chatId`, the soonest first. */
  async inChat(chatId: string): Promise<PendingCheck[]> {
    return (await this.pending())
      .filter((check) => check.chatId === chatId)
      .sort((a, b) => a.at - b.at)
      .map(({ chatId: _chat, ...check }) => check);
  }

  /** Cancels check `id` of chat `chatId`. Answers whether there was one. */
  async cancel(chatId: string, id: string): Promise<boolean> {
    const check = (await this.pending()).find((found) => found.id === id);
    if (!check || check.chatId !== chatId) return false;
    await this.remove(id);
    return true;
  }

  /** Cancels every check of task `taskId`, as when it is stopped or archived. Answers how many. */
  async cancelFor(taskId: string): Promise<number> {
    const checks = (await this.pending()).filter((check) => check.taskId === taskId);
    for (const check of checks) await this.remove(check.id);
    return checks.length;
  }

  private async remove(id: string): Promise<void> {
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
