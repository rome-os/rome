// Once the Concierge goes quiet, a fork of its own session checks its task
// list against the conversation and the task chats, and fixes what is wrong.
// The fork is the Concierge, so the list stays its own notebook. Design:
// rome-os/rome#1616.

import type { AgentEvent } from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-review");

/** Quiet time after the last Concierge turn before the review runs. */
export const REVIEW_DEBOUNCE_MS = 30_000;
/** How long the review may run before it is given up. */
export const REVIEW_TIMEOUT_MS = 180_000;

export const REVIEW_PROMPT = `<task_review>
Silent review of your task list. Nobody sees this turn. Use only task_list, chat_read, task_upsert.
1. task_list (includeDone: true). chat_read any task chat whose state is unclear.
2. Compare with this conversation and fix what is wrong or missing in ONE task_upsert:
   finished chat left doing → done, or needs_user if the result asked the guardian
   something; called-off task → dropped; a commitment with no row → create it;
   stale watching/next → fix. Always pass messageId (ids are in your earlier say /
   chat_forward / chat_card results).
3. If everything is right, write nothing. End with one line saying what changed.
</task_review>`;

export interface TaskReviewDeps {
  isEnabled(): Promise<boolean>;
  /** Whether a Concierge turn is running or queued. */
  turnLive(): boolean;
  /** Runs the prompt in an exact fork of the Concierge session. */
  fork(prompt: string, parentTurnId: string): AsyncIterable<AgentEvent>;
}

/** One debounce timer and at most one review at a time. */
export class TaskReviewer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastTurnId = "";

  constructor(private deps: TaskReviewDeps) {}

  /** A Concierge turn ended: the review waits for the quiet after it. */
  schedule(turnId: string): void {
    this.lastTurnId = turnId;
    this.arm();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.stop();
    this.timer = setTimeout(
      () =>
        void this.run().catch((error: unknown) =>
          log.warn("concierge task review failed to start", {
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      REVIEW_DEBOUNCE_MS,
    );
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    this.timer = null;
    const sourceTurnId = this.lastTurnId;
    // A running review saw the list before this turn's changes, so this one waits.
    if (this.running) return this.arm();
    // The live turn's own end schedules the next review.
    if (this.deps.turnLive()) return this.done(sourceTurnId, "skipped_live", 0, Date.now());
    if (!(await this.deps.isEnabled())) return;
    this.running = true;
    const startedAt = Date.now();
    let forkSessionId: string | undefined;
    let failure: string | undefined;
    let rowsWritten = 0;
    const upserts = new Map<string, number>();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), REVIEW_TIMEOUT_MS);
    });
    try {
      // Read to the end: the fork releases the Concierge session only then.
      const iterator = this.deps.fork(REVIEW_PROMPT, sourceTurnId)[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), timedOut]);
        if (next === "timeout") {
          // Abandoning the stream closes the fork at its next event.
          void iterator.return?.()?.catch(() => {});
          failure = `no end after ${REVIEW_TIMEOUT_MS} ms`;
          break;
        }
        if (next.done) break;
        const event = next.value;
        if (event.type === "turn_start") forkSessionId = event.sessionId;
        if (event.type === "error") failure = event.error;
        if (event.type === "tool_use" && event.tool.endsWith("task_upsert")) {
          const entries = (event.input as { tasks?: unknown } | null)?.tasks;
          upserts.set(event.id, Array.isArray(entries) ? entries.length : 0);
        }
        if (event.type === "tool_result" && !event.isError) {
          rowsWritten += upserts.get(event.toolUseId) ?? 0;
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
      this.running = false;
    }
    const outcome = failure ? "failed" : rowsWritten > 0 ? "wrote" : "nothing";
    this.done(sourceTurnId, outcome, rowsWritten, startedAt, {
      forkSessionId,
      ...(failure ? { error: failure } : {}),
    });
  }

  private done(
    sourceTurnId: string,
    outcome: "wrote" | "nothing" | "skipped_live" | "failed",
    rowsWritten: number,
    startedAt: number,
    extra: { forkSessionId?: string; error?: string } = {},
  ): void {
    const line = { sourceTurnId, outcome, rowsWritten, ms: Date.now() - startedAt, ...extra };
    if (outcome === "failed") log.warn("concierge_task_review", line);
    else log.info("concierge_task_review", line);
  }
}
