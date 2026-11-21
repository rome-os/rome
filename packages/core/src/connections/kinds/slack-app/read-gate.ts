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

export class SlackReadGate {
  private nextAt = 0;
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
    const running = (async () => {
      if (wait > 0) await (this.options.sleep ?? sleep)(wait, signal);
      try {
        return await call();
      } catch (error) {
        // Slack refused it as too soon: the next request waits a whole turn.
        if (error instanceof SlackApiError && error.code === "ratelimited") {
          this.nextAt = Math.max(this.nextAt, this.now() + this.options.intervalMs);
        }
        throw error;
      }
    })().finally(() => this.shared.delete(key));
    this.shared.set(key, running);
    return running;
  }
}
