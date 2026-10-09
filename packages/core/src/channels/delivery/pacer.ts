import type { Clock, ClockTimer } from "../../lib/clock.js";

/** How fast one account may write to a platform. */
export interface Budget {
  /** Writes the account may make back to back before it has to wait. */
  burst: number;
  /** How long one write's allowance takes to come back. */
  refillMs: number;
  /** The least time between two writes to the same conversation. */
  conversationSpacingMs: number;
}

interface Job {
  write: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface Lane {
  queue: Job[];
  /** When this conversation may next be written to. */
  readyAt: number;
  /** When it was last served, as a count of writes started; 0 for never. */
  servedTurn: number;
}

/**
 * Paces every write one account makes to a platform: ordinary sends, each
 * part of a split text, attachments, and streamed edits all go through the
 * one Pacer for that account.
 *
 * - One write runs at a time. Writes to one conversation run in the order
 *   they were asked for.
 * - Conversations take turns: when several can be written to, the one served
 *   longest ago goes first. A conversation still inside its spacing window
 *   never holds up one that is ready.
 * - A caller awaits the write itself, not its place in the queue.
 * - A write whose signal aborts before it starts is dropped and never runs.
 *   One already running finishes, and its result reaches the caller.
 *
 * At most one timer is pending, for the earliest moment something becomes
 * ready. A conversation's state is dropped once its queue is empty and its
 * spacing window has passed.
 */
export class Pacer {
  private readonly lanes = new Map<string, Lane>();
  private tokens: number;
  private refilledAt: number;
  private pausedUntil = 0;
  private running = false;
  private turns = 0;
  private timer?: ClockTimer;

  constructor(
    private readonly budget: Budget,
    private readonly clock: Clock,
  ) {
    this.tokens = budget.burst;
    this.refilledAt = this.now();
  }

  /** Runs `write` for `conversation` when the budget allows. */
  run<T>(conversation: string, write: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        write,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      let lane = this.lanes.get(conversation);
      if (!lane) {
        lane = { queue: [], readyAt: 0, servedTurn: 0 };
        this.lanes.set(conversation, lane);
      }
      lane.queue.push(job);
      signal?.addEventListener(
        "abort",
        () => {
          const queue = this.lanes.get(conversation)?.queue;
          const index = queue?.indexOf(job) ?? -1;
          if (index < 0) return;
          queue!.splice(index, 1);
          reject(signal.reason);
          this.pump();
        },
        { once: true },
      );
      this.pump();
    });
  }

  /**
   * Holds writes for `ms` after the platform asked to slow down: only those to
   * `conversation` when the limit was the conversation's, else every write.
   */
  pause(ms: number, conversation?: string): void {
    const until = this.now() + ms;
    if (conversation === undefined) this.pausedUntil = Math.max(this.pausedUntil, until);
    else {
      const lane = this.lanes.get(conversation) ?? { queue: [], readyAt: 0, servedTurn: 0 };
      lane.readyAt = Math.max(lane.readyAt, until);
      this.lanes.set(conversation, lane);
    }
    this.pump();
  }

  /** Conversations the pacer holds state for, for tests of its cleanup. */
  get size(): number {
    return this.lanes.size;
  }

  private pump(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return;

    const now = this.now();
    this.refill(now);
    let next = Number.POSITIVE_INFINITY;
    let chosen: Lane | undefined;
    for (const [conversation, lane] of this.lanes) {
      if (!lane.queue.length) {
        if (lane.readyAt <= now) this.lanes.delete(conversation);
        else next = Math.min(next, lane.readyAt);
        continue;
      }
      if (lane.readyAt > now) next = Math.min(next, lane.readyAt);
      else if (!chosen || lane.servedTurn < chosen.servedTurn) chosen = lane;
    }

    const allowedAt = Math.max(this.pausedUntil, this.tokenAt(now));
    if (chosen) {
      if (allowedAt <= now) return this.start(chosen);
      next = Math.min(next, allowedAt);
    } else if ([...this.lanes.values()].some((lane) => lane.queue.length)) {
      // Nothing queued is ready before its window opens and the budget allows.
      next = Math.max(next, allowedAt);
    }
    // Otherwise `next` is when an idle conversation's window closes, to drop it.
    if (Number.isFinite(next))
      this.timer = this.clock.setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, next - now);
  }

  private start(lane: Lane): void {
    const job = lane.queue.shift()!;
    lane.servedTurn = ++this.turns;
    this.tokens -= 1;
    this.running = true;
    void job
      .write()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running = false;
        // A pause the write itself asked for (a rate limit) outlasts the spacing.
        lane.readyAt = Math.max(lane.readyAt, this.now() + this.budget.conversationSpacingMs);
        this.pump();
      });
  }

  private refill(now: number): void {
    if (this.budget.refillMs <= 0) {
      this.tokens = this.budget.burst;
      return;
    }
    this.tokens = Math.min(
      this.budget.burst,
      this.tokens + (now - this.refilledAt) / this.budget.refillMs,
    );
    this.refilledAt = now;
  }

  /** When one whole write allowance is available. */
  private tokenAt(now: number): number {
    return this.tokens >= 1 ? now : now + Math.ceil((1 - this.tokens) * this.budget.refillMs);
  }

  private now(): number {
    return this.clock.now().getTime();
  }
}
