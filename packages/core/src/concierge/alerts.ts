// Delivery of outside events (a GitHub review request, a failed CI run) to the
// Concierge. Events wait in memory and reach it as one quiet system turn per
// batch, so a burst of events is one turn rather than one per event.
//
//   batch       a flush waits BATCH_DELAY_MS after the first event of a batch
//   rate limit  at most MAX_TURNS_PER_HOUR alert turns in any hour, and
//               MIN_SPACING_MS between two of them; events wait for the next slot
//   quiet hours the guardian's quiet window holds every event until it ends,
//               then they arrive as one batch marked as held
//
// Held events live in memory only: a restart drops them.

import { createLogger } from "../logger.js";

const log = createLogger("concierge-alerts");

export const BATCH_DELAY_MS = 60_000;
export const MIN_SPACING_MS = 15 * 60_000;
export const MAX_TURNS_PER_HOUR = 2;
export const HOUR_MS = 60 * 60_000;
/** Events a batch shows; the rest are given as a count. */
export const MAX_EVENTS_PER_BATCH = 20;
/** Events kept waiting; older ones are dropped and counted. */
const MAX_QUEUED = 200;
/** Event ids remembered so a redelivered event is not told twice. */
const MAX_SEEN_IDS = 1_000;

/** One outside event, already judged relevant to the guardian. */
export interface AlertEvent {
  /** Stable identity, so a redelivery is dropped. */
  id: string;
  /** Where it came from, such as `github`. */
  source: string;
  /** What happened, such as `review_requested`. */
  kind: string;
  /** Short fields for the payload: repo, title, url, actor. */
  fields: Record<string, string>;
  /** A short excerpt of outside text, such as a comment's body. */
  text?: string;
}

export interface AlertBatch {
  events: (AlertEvent & { at: number })[];
  /** Events beyond the batch's cap, or dropped from a full queue. */
  omitted: number;
  /** The batch waited out the guardian's quiet hours. */
  held: boolean;
}

export interface AlertDeps {
  now(): number;
  isEnabled(): Promise<boolean>;
  /** When the quiet window `at` falls in ends, or null when `at` is not quiet. */
  quietUntil(at: number): Promise<number | null>;
  /** Runs the batch as a system turn and settles when the turn ends. */
  deliver(batch: AlertBatch): Promise<void>;
}

export class AlertCoalescer {
  private queue: (AlertEvent & { at: number })[] = [];
  private overflow = 0;
  private seen = new Set<string>();
  private firstAt: number | null = null;
  private held = false;
  /** Start times of recent alert turns, oldest first. */
  private turns: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(private deps: AlertDeps) {}

  /** Queues an event. Answers false for a redelivered one. */
  add(event: AlertEvent): boolean {
    if (this.seen.has(event.id)) return false;
    this.seen.add(event.id);
    if (this.seen.size > MAX_SEEN_IDS) {
      const [oldest] = this.seen;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    const at = this.deps.now();
    this.queue.push({ ...event, at });
    if (this.queue.length > MAX_QUEUED) {
      this.queue.shift();
      this.overflow += 1;
    }
    this.firstAt ??= at;
    this.arm();
    return true;
  }

  /** Events waiting for a flush. */
  get pending(): number {
    return this.queue.length;
  }

  /** When the next flush may start, by batching and the rate limit alone. */
  nextFlushAt(): number | null {
    if (this.firstAt === null) return null;
    const now = this.deps.now();
    const recent = this.turns.filter((start) => start > now - HOUR_MS);
    const last = recent.at(-1);
    const oldest = recent[0];
    return Math.max(
      this.firstAt + BATCH_DELAY_MS,
      last === undefined ? Number.NEGATIVE_INFINITY : last + MIN_SPACING_MS,
      recent.length >= MAX_TURNS_PER_HOUR && oldest !== undefined
        ? oldest + HOUR_MS
        : Number.NEGATIVE_INFINITY,
    );
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.firstAt = null;
  }

  private arm(at = this.nextFlushAt()): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // The running flush re-arms when it ends.
    if (this.flushing || at === null) return;
    this.timer = setTimeout(() => void this.flush(), Math.max(0, at - this.deps.now()));
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    let rearmAt: number | undefined;
    try {
      if (!(await this.deps.isEnabled())) {
        this.queue = [];
        this.overflow = 0;
        this.firstAt = null;
        this.held = false;
        return;
      }
      const now = this.deps.now();
      const quietEnd = await this.deps.quietUntil(now);
      if (quietEnd !== null && quietEnd > now) {
        this.held = true;
        rearmAt = quietEnd;
        return;
      }
      const taken = this.queue;
      const batch: AlertBatch = {
        events: taken.slice(0, MAX_EVENTS_PER_BATCH),
        omitted: Math.max(0, taken.length - MAX_EVENTS_PER_BATCH) + this.overflow,
        held: this.held,
      };
      this.queue = [];
      this.overflow = 0;
      this.firstAt = null;
      this.held = false;
      this.turns = [...this.turns.filter((start) => start > now - HOUR_MS), now];
      await this.deps.deliver(batch);
    } catch (error) {
      log.warn("alert flush failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.flushing = false;
      if (this.queue.length === 0) {
        this.firstAt = null;
      } else {
        // Events that came during the turn start a batch of their own.
        this.firstAt ??= this.queue[0]?.at ?? this.deps.now();
      }
      if (rearmAt !== undefined) this.arm(Math.max(rearmAt, this.nextFlushAt() ?? rearmAt));
      else this.arm();
    }
  }
}

/** A daily quiet window in the guardian's zone, `HH:mm` to `HH:mm`. It may wrap midnight. */
export interface QuietHours {
  start: string;
  end: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseQuietHours(value: unknown): QuietHours | null {
  if (!value || typeof value !== "object") return null;
  const { start, end } = value as { start?: unknown; end?: unknown };
  if (typeof start !== "string" || typeof end !== "string") return null;
  if (!HHMM.test(start) || !HHMM.test(end) || start === end) return null;
  return { start, end };
}

const minutesOf = (hhmm: string) => {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/** Minutes past midnight of `at` in `timeZone`. */
function localMinutes(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

/** When the quiet window `at` falls in ends, or null when `at` is outside it. */
export function quietWindowEnd(at: number, quiet: QuietHours, timeZone: string): number | null {
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  const now = localMinutes(at, timeZone);
  const inside = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inside) return null;
  const left = (end - now + 24 * 60) % (24 * 60);
  // Back to the start of the current minute, then forward to the window's end.
  return at - (at % 60_000) + left * 60_000;
}
