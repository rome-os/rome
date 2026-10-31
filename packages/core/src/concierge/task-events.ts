// Delivery of task-chat changes to the Concierge. Each change marks its row
// dirty in memory; a flush hands the dirty rows to the Concierge as one system
// turn, so a burst of changes is one turn rather than one per change.
//
//   urgent  flush 2 s after the row went dirty: a result the Concierge asked
//           for, an error, a question or an approval
//   quiet   flush after 60 s, or with the next flush: the guardian's own
//           messages and turns, scheduled turns, a deleted chat
//
// At most one flush runs, at least 10 s after the last one started. A flush
// reads the rows from the database when it builds, so delivering a row twice
// is harmless. The Concierge settles a row by writing it: a write clears the
// row's mark unless a change came after the build. A row still unsettled after
// a flush is flushed once more, then given up as not synced. A flush whose turn
// the guardian stopped is the exception: its rows are dropped, with no retry
// and no give-up, since the guardian chose not to hear them out.

import { createLogger } from "../logger.js";

const log = createLogger("concierge-task-events");

export const URGENT_DELAY_MS = 2_000;
export const QUIET_DELAY_MS = 60_000;
export const MIN_FLUSH_SPACING_MS = 10_000;
/** A row is flushed this many times before it is given up as not synced. */
const MAX_FLUSHES_PER_CHANGE = 2;

/** One change of a task chat that the Concierge should hear about. */
export interface TaskChange {
  taskId: string;
  /** What the payload's `changes` attribute says, such as `turn_end:completed by=concierge`. */
  kind: string;
  /** Flush within seconds rather than minutes. */
  urgent: boolean;
  /** A line for the payload with what the database does not hold: the question, the approval, the guardian's words. */
  detail?: string;
}

/** A row waiting for a flush, as the payload builder sees it. */
export interface DirtyTask {
  taskId: string;
  changes: TaskChange[];
  /** No change of the row is urgent, so the payload marks it `quiet`. */
  quiet: boolean;
}

export interface TaskEventDeps {
  now(): number;
  isEnabled(): Promise<boolean>;
  /** The payload for these rows, read from the database now, or null when none of them exist any more. */
  render(tasks: DirtyTask[]): Promise<string | null>;
  /**
   * Runs the payload as a system turn and settles when the turn ends. Resolves
   * `{ stopped: true }` when the guardian pressed Stop on the turn. A new
   * message that superseded the turn is not a Stop.
   */
  deliver(prompt: string, options: { quiet: boolean }): Promise<void | { stopped: boolean }>;
  /** The row was flushed and still not settled after its retry. */
  giveUp(taskId: string): void;
}

interface Dirty {
  /** When the first change since the last settled flush arrived; a change after a build restarts it. */
  since: number;
  changes: TaskChange[];
  urgent: boolean;
  /** When the flush that took this row built its payload. */
  builtAt?: number;
  /** Flushes spent on the changes since `since`. */
  flushes: number;
  /** A flush took the row and the Concierge did not write it. */
  retry: boolean;
}

export class TaskEventCoalescer {
  private dirty = new Map<string, Dirty>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private lastFlushStartedAt = Number.NEGATIVE_INFINITY;

  constructor(private deps: TaskEventDeps) {}

  /** Marks a row dirty with one more change. */
  mark(change: TaskChange): void {
    const now = this.deps.now();
    const entry = this.dirty.get(change.taskId);
    if (!entry) {
      this.dirty.set(change.taskId, {
        since: now,
        changes: [change],
        urgent: change.urgent,
        flushes: 0,
        retry: false,
      });
    } else if (entry.builtAt !== undefined && entry.since <= entry.builtAt) {
      // Everything the entry holds went into a payload already. This change
      // came after the build, so it is a new round, and a write that settles
      // the old round must not clear it.
      entry.since = now;
      entry.changes = [change];
      entry.urgent = change.urgent;
      entry.flushes = 0;
      entry.retry = false;
    } else {
      entry.changes.push(change);
      entry.urgent ||= change.urgent;
    }
    this.arm();
  }

  /** The Concierge wrote the row. Clears its mark unless a change came after the build. */
  settle(taskId: string): void {
    const entry = this.dirty.get(taskId);
    if (entry && entry.builtAt !== undefined && entry.since <= entry.builtAt) {
      this.dirty.delete(taskId);
    }
  }

  /** Drops a row's mark, such as when its row is gone. */
  forget(taskId: string): void {
    this.dirty.delete(taskId);
  }

  /** The rows waiting for a flush. */
  get pending(): string[] {
    return [...this.dirty.keys()];
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty.clear();
  }

  private dueAt(entry: Dirty): number {
    if (entry.retry) return Number.NEGATIVE_INFINITY;
    return entry.since + (entry.urgent ? URGENT_DELAY_MS : QUIET_DELAY_MS);
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // The running flush re-arms when it ends.
    if (this.flushing || this.dirty.size === 0) return;
    const due = Math.min(...[...this.dirty.values()].map((entry) => this.dueAt(entry)));
    const at = Math.max(due, this.lastFlushStartedAt + MIN_FLUSH_SPACING_MS);
    this.timer = setTimeout(() => void this.flush(), Math.max(0, at - this.deps.now()));
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.flushing || this.dirty.size === 0) return;
    this.flushing = true;
    const builtAt = this.deps.now();
    this.lastFlushStartedAt = builtAt;
    const taken = [...this.dirty.entries()];
    let stopped = false;
    for (const [, entry] of taken) {
      entry.builtAt = builtAt;
      entry.flushes += 1;
    }
    try {
      if (!(await this.deps.isEnabled())) {
        for (const [taskId] of taken) this.dirty.delete(taskId);
        return;
      }
      const tasks = taken.map(([taskId, entry]) => ({
        taskId,
        changes: entry.changes,
        quiet: !entry.urgent,
      }));
      const prompt = await this.deps.render(tasks);
      if (!prompt) {
        for (const [taskId] of taken) this.dirty.delete(taskId);
        return;
      }
      const delivery = await this.deps.deliver(prompt, {
        quiet: tasks.every((task) => task.quiet),
      });
      stopped = delivery?.stopped === true;
    } catch (error) {
      log.warn("task event flush failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.flushing = false;
      this.afterFlush(
        taken.map(([taskId]) => taskId),
        stopped,
      );
      this.arm();
    }
  }

  private afterFlush(taskIds: string[], stopped: boolean): void {
    for (const taskId of taskIds) {
      const entry = this.dirty.get(taskId);
      if (!entry) continue;
      if (entry.builtAt !== undefined && entry.since > entry.builtAt) {
        // A change came after the build: it waits for its own flush.
        entry.builtAt = undefined;
        entry.flushes = 0;
        entry.retry = false;
      } else if (stopped) {
        this.dirty.delete(taskId);
      } else if (entry.flushes >= MAX_FLUSHES_PER_CHANGE) {
        this.dirty.delete(taskId);
        this.deps.giveUp(taskId);
      } else {
        entry.retry = true;
      }
    }
  }
}
