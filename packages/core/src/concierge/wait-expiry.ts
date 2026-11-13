// A wait on a task's owner ends: a question card or an approval in its task
// chat that nobody answered within the expiry (a day by default). The task
// ends for no response, as its status already reads; Rome then turns down
// the chat's approvals, tells the Concierge quietly, and has the next digest
// list the task once. The card stays answerable. docs/domains/chats.md#task

import type { ConciergeTasks, TaskStatusView } from "./tasks.js";
import { RESOLVED_BY_EXPIRY, type TurnDown } from "./approval-expiry.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-wait-expiry");

/** What the approvals an expiry turns down say. */
export const NO_RESPONSE_REASON = "No response within a day";

/** How long a failed expiry waits before it is tried again, doubling up to the most. */
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 60 * 60 * 1000;

/** The longest a timer waits in one go; a later expiry re-arms. */
const MAX_TIMER_MS = 24 * 24 * 60 * 60 * 1000;

export interface WaitExpiryDeps {
  tasks: ConciergeTasks;
  /** Turns down chat `chatId`'s approvals still pending (approval-expiry.ts). Answers how many. */
  expireApprovals?: (chatId: string, turnDown: TurnDown) => Promise<number>;
  /** Tells the Concierge that task `taskId` ended for no response. */
  tell: (taskId: string) => void;
  now?: () => number;
}

export class WaitExpiry {
  private timers = new Map<
    string,
    { at: number; timer: ReturnType<typeof setTimeout>; retry: boolean }
  >();
  /** How many attempts in a row failed, by task. */
  private failures = new Map<string, number>();
  private readonly now: () => number;
  private stopped = false;
  /** Tasks whose expiry runs now: another call for one of them does nothing. */
  private handling = new Set<string>();

  constructor(private readonly deps: WaitExpiryDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Arms a timer for every open wait it hears of, and reads every task with
   * a task chat once, so the waits a restart left are armed again; one that
   * expired meanwhile is handled now, and one handled before a restart that
   * still has an approval pending has it turned down. Returns the stop.
   */
  start(): () => void {
    const off = this.deps.tasks.onStatus((taskId, status) => this.arm(taskId, status));
    void this.deps.tasks.repo
      .listForAgent(true)
      .then(async (rows) => {
        const open = rows.map((task) => task.row).filter((row) => row.sessionId && !row.stoppedAt);
        const status = await this.deps.tasks.statusOf(open);
        for (const [taskId, view] of status) {
          if (view.waitingSince !== null && view.expiredWaitAt === view.waitingSince) {
            this.run(taskId);
          }
        }
      })
      .catch((error: unknown) =>
        log.warn("failed to read the open waits", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return () => {
      this.stopped = true;
      off();
      for (const { timer } of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    };
  }

  private arm(taskId: string, status: TaskStatusView): void {
    if (this.stopped) return;
    const known = this.timers.get(taskId);
    // A stopped task waits for no one, and a wait Rome already ended waits
    // for nothing more, though its card stays answerable. A failed attempt
    // keeps its own timer, which backs off.
    if (
      status.waitingSince === null ||
      status.endReason === "stopped" ||
      status.expiredWaitAt === status.waitingSince
    ) {
      if (known && !known.retry) {
        clearTimeout(known.timer);
        this.timers.delete(taskId);
      }
      return;
    }
    if (known?.retry) return;
    const at = status.waitingSince + this.deps.tasks.waitExpiry;
    if (known?.at === at) return;
    if (known) clearTimeout(known.timer);
    this.schedule(taskId, at, false);
  }

  private schedule(taskId: string, at: number, retry: boolean): void {
    const delay = Math.max(0, Math.min(at - this.now(), MAX_TIMER_MS));
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      this.run(taskId);
    }, delay);
    timer.unref?.();
    this.timers.set(taskId, { at, timer, retry });
  }

  /** Handles task `taskId`'s expiry; a failure tries again later, backing off. */
  private run(taskId: string): void {
    void this.expire(taskId).then(
      () => this.failures.delete(taskId),
      (error: unknown) => {
        const failures = (this.failures.get(taskId) ?? 0) + 1;
        this.failures.set(taskId, failures);
        log.warn("failed to end a wait", {
          taskId,
          failures,
          error: error instanceof Error ? error.message : String(error),
        });
        if (this.stopped) return;
        const wait = Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS);
        const known = this.timers.get(taskId);
        if (known) clearTimeout(known.timer);
        this.schedule(taskId, this.now() + wait, true);
      },
    );
  }

  /**
   * The wait of task `taskId` may have expired: handles it once, if it did.
   * A call while one for the same task runs does nothing, so the expiry is
   * handled and logged once.
   */
  async expire(taskId: string): Promise<void> {
    if (this.handling.has(taskId)) return;
    this.handling.add(taskId);
    try {
      await this.handle(taskId);
    } finally {
      this.handling.delete(taskId);
    }
  }

  private async handle(taskId: string): Promise<void> {
    const row = await this.deps.tasks.repo.get(taskId);
    // A stopped or archived task ended otherwise: its wait ends with nothing to tell.
    if (!row?.sessionId || row.stoppedAt || row.archivedAt) return;
    // Read again: the read re-arms a wait that is not due yet.
    const status = (await this.deps.tasks.statusOf([row])).get(taskId);
    if (!status || status.waitingSince === null) return;
    const deadline = status.waitingSince + this.deps.tasks.waitExpiry;
    if (this.now() < deadline) return;
    // The expiry is kept before anything acts on it, so a restart part way
    // through finishes it rather than losing it: the task reads ended for no
    // response, the Concierge is told once, and then the approvals still
    // pending are turned down. A turn-down is idempotent and is tried again
    // until it succeeds; the turns that carry on from it run on their own.
    const handled =
      row.expiredWaitAt?.getTime() === status.waitingSince ||
      !(await this.deps.tasks.repo.markWaitExpired(taskId, new Date(status.waitingSince)));
    if (!handled) {
      this.deps.tell(taskId);
      await this.deps.tasks.taskChanged(taskId);
    }
    const turnedDown = await this.deps.expireApprovals?.(row.sessionId, {
      until: deadline,
      reason: NO_RESPONSE_REASON,
      resolvedBy: RESOLVED_BY_EXPIRY,
      continueTurn: true,
    });
    if (!handled) log.info("task wait expired", { taskId, approvals: turnedDown ?? 0 });
  }
}
