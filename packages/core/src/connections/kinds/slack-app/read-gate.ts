// Slack lets an app call conversations.history about once a minute in each
// workspace, so the connection asks it at most that often. Reads that ask for
// the same page share one request, and a read waits for its turn up to a
// limit, past which it is refused with when to try again.

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
   *  shares its answer. */
  run<T>(key: string, call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const pending = this.shared.get(key);
    if (pending) return pending as Promise<T>;
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    const wait = at - now;
    if (wait > this.options.maxWaitMs) {
      const seconds = Math.ceil(wait / 1_000);
      return Promise.reject(
        new Error(
          `Could not read these messages yet: Slack lets Rome read this workspace's history about once a minute, and other reads are waiting. Say that you could not read the earlier messages yet rather than answer as if you had. Try again in ${seconds} seconds.`,
        ),
      );
    }
    this.nextAt = at + this.options.intervalMs;
    const before = this.last;
    const pause = this.options.sleep ?? sleep;
    const running = (async () => {
      if (wait > 0) await pause(wait, signal);
      // Slack counts its minute from the request it answered, which comes
      // later than this turn's start when the request before ran long or
      // waited out a refusal.
      await before;
      const late = this.answeredAt + this.options.intervalMs - Math.max(at, this.now());
      if (late > 0) await pause(late, signal);
      try {
        return await call();
      } finally {
        this.answeredAt = this.now();
        this.nextAt = Math.max(this.nextAt, this.answeredAt + this.options.intervalMs);
      }
    })().finally(() => this.shared.delete(key));
    this.last = running.catch(() => {});
    this.shared.set(key, running);
    return running;
  }
}
