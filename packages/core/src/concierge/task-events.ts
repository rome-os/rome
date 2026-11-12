// Delivery of task-chat changes to the Concierge. Each change marks its row
// dirty in memory; a flush hands the dirty rows to the Concierge as one system
// turn per Concierge chat the rows came from, so a burst of changes is one
// turn per chat rather than one per change.
//
//   urgent  flush 2 s after the row went dirty: a result the Concierge asked
//           for, an error, a question or an approval
//   quiet   flush after 60 s, or with the next flush: the guardian's own
//           messages and turns, scheduled turns, a deleted chat
//
//   passive  never flushes on its own: a scheduled turn that finished with
//           nothing to ask or report goes with the next flush or digest
//
// At most one flush runs, at least 10 s after the last one started. A flush
// reads the rows from the database when it builds, so delivering a row twice
// is harmless. A turn that ran to its end settles what it carried: Rome keeps
// each task's status, so the Concierge owes no write. A row whose turn did
// not run to its end, such as when the Concierge is out of quota, is tried
// again RETRY_MS later. A row whose turn a newer message cut short is tried
// again with the next flush, once the turn that took it over no longer
// carries it. A row whose turn the guardian stopped is given up.

import { withoutSessionActor } from "../access/session-actor.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-task-events");

export const URGENT_DELAY_MS = 2_000;
export const QUIET_DELAY_MS = 60_000;
export const MIN_FLUSH_SPACING_MS = 10_000;
export const RETRY_MS = 5 * 60_000;

/** One change of a task chat that the Concierge should hear about. */
export interface TaskChange {
  taskId: string;
  /** What the payload's `changes` attribute says, such as `turn_end:completed by=concierge`. */
  kind: string;
  /** Flush within seconds rather than minutes. */
  urgent: boolean;
  /** A line for the payload with what the database does not hold: the question, the approval, the guardian's words. */
  detail?: string;
  /**
   * Needs no word from the Concierge, such as a scheduled turn that finished
   * with nothing to ask: it waits for the next flush or digest, and wakes no
   * turn of its own.
   */
  passive?: boolean;
}

/** A row waiting for a flush, as the payload builder sees it. */
export interface DirtyTask {
  taskId: string;
  changes: TaskChange[];
  /** No change of the row is urgent, so the payload marks it `quiet`. */
  quiet: boolean;
}

/** One system turn of a flush: the payload for the rows of one Concierge chat. */
export interface TaskEventDelivery {
  /** The Concierge chat the rows came from. Null is the main chat. */
  chatId: string | null;
  /** Whose rows they are, so a chat that is gone sends them to that owner's main chat. */
  owner: string;
  /** The rows the payload carries. */
  taskIds: string[];
  prompt: string;
  /** No row in it has an urgent change. */
  quiet: boolean;
}

export interface TaskEventDeps {
  now(): number;
  /** The payloads for these rows, read from the database now, one per Concierge chat; empty when none of them exist any more. */
  render(tasks: DirtyTask[]): Promise<TaskEventDelivery[]>;
  /** Runs one payload as a system turn in its chat and answers how the turn ended. */
  deliver(delivery: TaskEventDelivery): Promise<"completed" | "stopped" | "interrupted" | "failed">;
  /** The turn that carried the row was stopped by the guardian: its news is not handed over again. */
  giveUp(taskId: string): void;
  /**
   * Whether a Concierge turn that took a cut-short report over still runs
   * with this row's news, which it may say itself. Such a row waits for it.
   */
  carried?(taskId: string): boolean;
}

interface Dirty {
  /** When the first change since the last settled flush arrived; a change after a build restarts it. */
  since: number;
  /**
   * Goes up with every change, and is new for a new entry: what a turn
   * carried or said is forgotten only while it is still all there is.
   */
  version: number;
  changes: TaskChange[];
  urgent: boolean;
  /** Every change needs no word: the row waits for another one's flush. */
  passive: boolean;
  /** Until when the row waits for a turn that took its cut-short report over: never past RETRY_MS. */
  carriedUntil?: number;
  /** When the flush that took this row built its payload. */
  builtAt?: number;
  /** The turn that carried the row did not run to its end: its changes still wait. */
  undelivered?: boolean;
  /** Not flushed before this time, after a turn that did not run. */
  notBefore?: number;
}

/** The news a turn said for one row, as {@link TaskEventCoalescer.snapshot} took it. */
export type SaidNews = { readonly entry: object; readonly version: number } | null;

export class TaskEventCoalescer {
  private dirty = new Map<string, Dirty>();
  private versions = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private lastFlushStartedAt = Number.NEGATIVE_INFINITY;
  /** Rows the running flush took, until it ends. */
  private inFlight = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(private deps: TaskEventDeps) {}

  /**
   * Calls `listener` whenever {@link awaitingReport} may have changed.
   * Returns the unsubscribe.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The rows with an urgent change the Concierge is about to report: no
   * flush has taken it yet, or the flush that took it is still setting up
   * or running its turn. A row waiting out a turn that did not run, or kept
   * for a retry after a turn that did, is not about to be reported.
   */
  get awaitingReport(): string[] {
    const now = this.deps.now();
    return [...this.dirty.entries()]
      .filter(([taskId, entry]) => {
        if (!entry.urgent) return false;
        if (this.inFlight.has(taskId)) return true;
        if (entry.notBefore !== undefined && entry.notBefore > now) return false;
        return entry.builtAt === undefined || entry.since > entry.builtAt;
      })
      .map(([taskId]) => taskId);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Marks a row dirty with one more change. */
  mark(change: TaskChange): void {
    const now = this.deps.now();
    const entry = this.dirty.get(change.taskId);
    if (!entry) {
      this.dirty.set(change.taskId, {
        version: ++this.versions,
        since: now,
        changes: [change],
        urgent: change.urgent,
        passive: change.passive === true,
      });
    } else if (entry.builtAt !== undefined && entry.since <= entry.builtAt && !entry.undelivered) {
      // Everything the entry holds went into a payload already. This change
      // came after the build, so it is a new round, and a write that settles
      // the old round must not clear it.
      entry.version = ++this.versions;
      entry.since = now;
      entry.changes = [change];
      entry.urgent = change.urgent;
      entry.passive = change.passive === true;
    } else {
      entry.version = ++this.versions;
      entry.changes.push(change);
      entry.urgent ||= change.urgent;
      entry.passive &&= change.passive === true;
      // A write must not settle a change that no turn has carried yet.
      if (entry.undelivered) entry.builtAt = undefined;
    }
    this.arm();
    this.changed();
  }

  /**
   * The Concierge wrote the row, or said its news. Clears its mark unless a
   * change came after the build, or the turn built to carry it never reached
   * the Concierge: that news is still owed, and its retry goes ahead. While
   * the turn carrying it runs, how that turn ends decides: a write in a
   * report that then fails settles nothing. `delivered` is that turn ending
   * complete.
   */
  settle(taskId: string, options: { delivered?: boolean } = {}): void {
    if (!options.delivered && this.inFlight.has(taskId)) return;
    const entry = this.dirty.get(taskId);
    if (
      entry &&
      entry.builtAt !== undefined &&
      entry.since <= entry.builtAt &&
      !entry.undelivered
    ) {
      this.dirty.delete(taskId);
      this.changed();
    }
  }

  /**
   * Whether task `taskId` has news a turn was built to carry but that never
   * reached the Concierge, as when that turn failed or was cut short.
   */
  unseen(taskId: string): boolean {
    return this.dirty.get(taskId)?.undelivered === true;
  }

  /**
   * The rows of `taskIds` whose every change needs no word, which a digest
   * lists instead of a turn of their own. Read only: the digest settles them
   * with {@link settlePassive} once its turn ran to its end.
   */
  passiveOf(taskIds: readonly string[]): string[] {
    return taskIds.filter((taskId) => {
      const entry = this.dirty.get(taskId);
      return entry?.passive === true && !this.inFlight.has(taskId);
    });
  }

  /**
   * Settles the rows of `taskIds` a digest listed. A row that got a change
   * needing a word meanwhile stays, for a turn of its own.
   */
  settlePassive(taskIds: readonly string[]): void {
    const settled = this.passiveOf(taskIds);
    for (const taskId of settled) this.dirty.delete(taskId);
    if (settled.length > 0) this.changed();
  }

  /** Drops a row's mark, such as when its row is gone. */
  forget(taskId: string): void {
    if (this.dirty.delete(taskId)) this.changed();
  }

  /**
   * The news waiting for row `taskId` now, as a turn that says it carries
   * it: what {@link forgetSaid} later forgets, and no more.
   */
  snapshot(taskId: string): SaidNews {
    const entry = this.dirty.get(taskId);
    return entry ? { entry, version: entry.version } : null;
  }

  /**
   * A turn said row `taskId`'s news as it stood at `said`: it waits for no
   * other turn. News that came after stays. Answers whether nothing is left
   * waiting for the row.
   */
  forgetSaid(taskId: string, said: SaidNews): boolean {
    const entry = this.dirty.get(taskId);
    if (!entry) return true;
    if (said && entry === said.entry && entry.version === said.version) {
      this.dirty.delete(taskId);
      this.changed();
      return true;
    }
    return false;
  }

  /** Whether news waits for row `taskId`. */
  waiting(taskId: string): boolean {
    return this.dirty.has(taskId);
  }

  /** The rows waiting for a flush. */
  get pending(): string[] {
    return [...this.dirty.keys()];
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty.clear();
    this.inFlight.clear();
    this.changed();
    this.listeners.clear();
  }

  private dueAt(entry: Dirty): number {
    // A passive row waits for another row's flush.
    if (entry.passive) return Number.POSITIVE_INFINITY;
    const due = entry.since + (entry.urgent ? URGENT_DELAY_MS : QUIET_DELAY_MS);
    return Math.max(due, entry.notBefore ?? Number.NEGATIVE_INFINITY);
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // The running flush re-arms when it ends.
    if (this.flushing || this.dirty.size === 0) return;
    const due = Math.min(...[...this.dirty.values()].map((entry) => this.dueAt(entry)));
    if (due === Number.POSITIVE_INFINITY) return;
    const at = Math.max(due, this.lastFlushStartedAt + MIN_FLUSH_SPACING_MS);
    // A mark arrives in whoever's request changed the row; the flush runs
    // every owner's turns, so its timer must carry no one's session actor.
    this.timer = withoutSessionActor(() =>
      setTimeout(() => void this.flush(), Math.max(0, at - this.deps.now())),
    );
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.flushing || this.dirty.size === 0) return;
    this.flushing = true;
    const builtAt = this.deps.now();
    this.lastFlushStartedAt = builtAt;
    // A row waiting out a turn that did not run stays behind until its time.
    // One the turn that took a cut-short report over still carries waits for
    // it, and is looked at again with the next flush.
    const taken = [...this.dirty.entries()].filter(([taskId, entry]) => {
      if ((entry.notBefore ?? Number.NEGATIVE_INFINITY) > builtAt) return false;
      if (builtAt >= (entry.carriedUntil ?? 0) || !this.deps.carried?.(taskId)) return true;
      entry.notBefore = builtAt + MIN_FLUSH_SPACING_MS;
      return false;
    });
    // Every row waits: nothing to hand over yet.
    if (taken.length === 0) {
      this.flushing = false;
      this.arm();
      return;
    }
    // Rows whose turn did not run to its end; all of them until delivery starts.
    const notRun = new Set(taken.map(([taskId]) => taskId));
    // Rows whose turn the guardian stopped.
    const stopped = new Set<string>();
    // Rows whose turn a newer message cut short.
    const superseded = new Set<string>();
    // What each row's turn carries, kept in case the turn does not run.
    const carried = new Map(
      taken.map(([taskId, entry]) => [
        taskId,
        { entry, changes: entry.changes, urgent: entry.urgent, version: entry.version },
      ]),
    );
    // Rows whose turn ran to its end.
    const completed = new Set<string>();
    for (const [taskId, entry] of taken) {
      entry.builtAt = builtAt;
      entry.undelivered = false;
      this.inFlight.add(taskId);
    }
    try {
      const tasks = taken.map(([taskId, entry]) => ({
        taskId,
        changes: entry.changes,
        quiet: !entry.urgent,
      }));
      const deliveries = await this.deps.render(tasks);
      if (deliveries.length === 0) {
        for (const [taskId] of taken) this.dirty.delete(taskId);
        return;
      }
      notRun.clear();
      // One chat's turn failing leaves the other chats' turns to run.
      for (const delivery of deliveries) {
        const outcome = await this.deps.deliver(delivery).catch((error: unknown) => {
          log.warn("task event delivery to one chat failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return "failed" as const;
        });
        if (outcome === "completed") {
          for (const taskId of delivery.taskIds) completed.add(taskId);
          continue;
        }
        // Only a Stop drops what the turn carried. A turn a newer message cut
        // short may never have sent it to the model.
        const ended =
          outcome === "stopped" ? stopped : outcome === "interrupted" ? superseded : notRun;
        for (const taskId of delivery.taskIds) ended.add(taskId);
      }
    } catch (error) {
      log.warn("task event flush failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.flushing = false;
      this.inFlight.clear();
      this.afterFlush(
        taken.map(([taskId]) => taskId),
        notRun,
        superseded,
        stopped,
        completed,
        carried,
      );
      this.arm();
      this.changed();
    }
  }

  private afterFlush(
    taskIds: string[],
    notRun: Set<string>,
    superseded: Set<string>,
    stopped: Set<string>,
    completed: Set<string>,
    carried: Map<string, { entry: Dirty; changes: TaskChange[]; urgent: boolean; version: number }>,
  ): void {
    for (const taskId of taskIds) {
      const entry = this.dirty.get(taskId);
      if (!entry) continue;
      if (notRun.has(taskId) || superseded.has(taskId)) {
        // The turn did not run to its end: the changes stay, later ones join
        // them, a write still settles them, and the attempt does not count.
        const before = carried.get(taskId);
        // A write settled the row while the turn ran and a later change
        // started afresh: the failed turn carried none of it.
        if (before && entry !== before.entry) continue;
        if (before && entry.changes !== before.changes) {
          // A change while the turn ran started a new round: the carried
          // changes go back in front of it, and no write has settled them.
          entry.changes = [...before.changes, ...entry.changes];
          entry.urgent ||= before.urgent;
          entry.builtAt = undefined;
        }
        entry.undelivered = true;
        // A newer message took the turn over: the next flush tries again,
        // once that turn no longer carries the row. A failure waits RETRY_MS.
        entry.notBefore = superseded.has(taskId)
          ? this.deps.now() + URGENT_DELAY_MS
          : this.deps.now() + RETRY_MS;
        if (superseded.has(taskId)) entry.carriedUntil = this.deps.now() + RETRY_MS;
      } else if (stopped.has(taskId) && entry.changes === carried.get(taskId)?.changes) {
        // The guardian stopped the turn: what it carried is never handed over
        // again, and the row shows it is not synced.
        this.dirty.delete(taskId);
        this.deps.giveUp(taskId);
      } else if (entry.builtAt !== undefined && entry.since > entry.builtAt) {
        // A change came after the build: it waits for its own flush.
        entry.builtAt = undefined;
      } else if (completed.has(taskId)) {
        // The turn ran to its end with the row's news: one delivery is enough.
        // News that replaced what it carried, after a write settled that,
        // waits for its own flush.
        const before = carried.get(taskId);
        if (before && entry === before.entry && entry.version === before.version) {
          this.dirty.delete(taskId);
        }
      }
    }
  }
}
