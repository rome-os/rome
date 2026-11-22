// Slack lets an app call conversations.history about once a minute in each
// workspace, so the connection asks it at most that often. Reads that ask for
// the same page share one request, and a read waits for its turn up to a
// limit, past which it is refused with when to try again.

import { SlackApiError } from "../slack/slack.js";

export interface SlackReadGateOptions {
  /** The least time between two requests. */
  intervalMs: number;
  /** The longest a read waits for its turn. */
  maxWaitMs: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Slack refused a request as too soon, and said how long to wait. */
export class SlackTooSoonError extends SlackApiError {
  constructor(readonly retryAfterMs: number) {
    super("ratelimited", `Slack asked Rome to wait ${retryAfterMs}ms.`);
  }
}

/** How much longer than its turn a read may wait: for the request before it
 *  to be answered, or for a wait Slack asks for. With a minute's turn and one
 *  request of up to 15 s, a read ends within the 90 s its callers allow. */
const LATE_MS = 10_000;

function tooSoon(waitMs: number): Error {
  const seconds = Math.ceil(waitMs / 1_000);
  return new Error(
    `Could not read these messages yet: Slack lets Rome read this workspace's history about once a minute, and other reads are waiting. Say that you could not read the earlier messages yet rather than answer as if you had. Try again in ${seconds} seconds.`,
  );
}

export class SlackReadGate {
  private nextAt = 0;
  /** When Slack last answered a request, which starts its next minute. */
  private answeredAt = Number.NEGATIVE_INFINITY;
  private last: Promise<unknown> = Promise.resolve();
  private readonly shared = new Map<string, Promise<unknown>>();

  constructor(private readonly options: SlackReadGateOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Run `call` in its turn. A call with the `key` of one waiting or running
   *  shares its answer. A read waits at most `maxWaitMs` for its turn, and
   *  past that only `LATE_MS` more for the request before it to be answered
   *  or for a wait Slack asks for. It is refused rather than wait longer. */
  run<T>(key: string, call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const pending = this.shared.get(key);
    if (pending) return pending as Promise<T>;
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    const wait = at - now;
    if (wait > this.options.maxWaitMs) return Promise.reject(tooSoon(wait));
    this.nextAt = at + this.options.intervalMs;
    const before = this.last;
    const pause = this.options.sleep ?? sleep;
    const deadline = now + this.options.maxWaitMs + LATE_MS;
    // Refuses a wait that would take the read past its deadline.
    const waitOut = async (ms: number) => {
      if (ms <= 0) return;
      if (this.now() + ms > deadline) throw tooSoon(ms);
      await pause(ms, signal);
    };
    let asked = false;
    const ask = () => {
      asked = true;
      return call();
    };
    const running = (async () => {
      if (wait > 0) await pause(wait, signal);
      // Slack counts its minute from the request it answered, which comes
      // later than this turn's start when the request before ran long or
      // waited out a refusal.
      await before;
      try {
        await waitOut(this.answeredAt + this.options.intervalMs - Math.max(at, this.now()));
      } catch (error) {
        // A read refused before it asked gives its turn back, unless a later
        // read has booked past it.
        if (this.nextAt === at + this.options.intervalMs) {
          this.nextAt = Math.max(this.answeredAt + this.options.intervalMs, at);
        }
        throw error;
      }
      try {
        try {
          return await ask();
        } catch (error) {
          // A refusal as too soon is the one failure waiting is known to cure.
          if (!(error instanceof SlackTooSoonError)) throw error;
          this.nextAt = Math.max(this.nextAt, this.now() + error.retryAfterMs);
          await waitOut(error.retryAfterMs);
          return await ask();
        }
      } finally {
        if (asked) {
          this.answeredAt = this.now();
          this.nextAt = Math.max(this.nextAt, this.answeredAt + this.options.intervalMs);
        }
      }
    })().finally(() => this.shared.delete(key));
    this.last = running.catch(() => {});
    this.shared.set(key, running);
    return running;
  }
}
