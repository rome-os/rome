import { v4 as uuid } from "uuid";
import type { TriggerProvider } from "./trigger-provider.js";
import type { Routine, RoutineRunStatus } from "./types.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import { toRoutine } from "../db/repositories/routines.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import type { ActionEngine } from "../actions/engine.js";
import { createLogger } from "../logger.js";
import { withRomeSpan } from "../telemetry.js";
import { runWithoutHookInvocationContext } from "../core/hook-recursion.js";
import type { Clock, ClockTimer } from "../lib/clock.js";

const log = createLogger("routine-engine");

export class RoutineEngine {
  private providers = new Map<string, TriggerProvider>();
  private retryTimers = new Set<ClockTimer>();
  // rootExecutionIds we've asked the action engine to kill. dispatch's catch
  // consults this so a guardian-requested stop is recorded as "cancelled"
  // (not "error") and is never retried.
  private cancellingExecutions = new Set<string>();

  constructor(
    private routinesRepo: RoutinesRepository,
    private routineRunsRepo: RoutineRunsRepository,
    private actionEngine: ActionEngine,
    /** Delay before retrying after a failed action. `0` disables retry. */
    private retryDelayMs: number,
    /** Time source for run durations, lastFiredAt, and the retry timer. */
    private clock: Clock,
  ) {}

  registerProvider(type: string, provider: TriggerProvider): void {
    this.providers.set(type, provider);
    log.info("trigger provider registered", { type });
  }

  /** Whether the engine can execute routines of this trigger type. The API
   * uses this to fail-closed on triggers we have no provider for, rather
   * than persisting a routine that will silently never fire. */
  hasProvider(type: string): boolean {
    return this.providers.has(type);
  }

  async start(): Promise<void> {
    const rows = await this.routinesRepo.findEnabled();
    for (const row of rows) {
      const routine = toRoutine(row);
      await this.activate(routine);
    }
    log.info("routine engine started", { routineCount: rows.length });
  }

  async activate(routine: Routine): Promise<void> {
    const provider = this.providers.get(routine.trigger.type);
    if (!provider) {
      log.warn("no provider for trigger type", {
        routineId: routine.id,
        triggerType: routine.trigger.type,
      });
      return;
    }
    await provider.activate(routine, async (payload) => {
      // A trigger fire ignores the dispatch outcome (it's surfaced via the run
      // record); only the manual runNow() path reads the return value.
      await this.dispatch(routine, payload);
    });
  }

  /** Re-activate every enabled floating schedule so it picks up a new guardian
   * timezone. Floating is the default, so this is every schedule
   * whose tzMode is not the explicit `fixed`. Called from the settings write
   * path when `guardianTimezone` changes. `activate()` tears down the old croner
   * job and recomputes `nextRun` from now, so this never double-fires or replays
   * a missed occurrence. Explicitly-`fixed` (absolute-zone) routines and other
   * trigger types are left untouched — their zone is, by definition, not the
   * guardian's. */
  async reactivateFloating(): Promise<void> {
    const rows = await this.routinesRepo.findEnabled();
    let count = 0;
    for (const row of rows) {
      const routine = toRoutine(row);
      if (routine.trigger.type === "schedule" && routine.trigger.tzMode !== "fixed") {
        await this.activate(routine);
        count++;
      }
    }
    if (count > 0) {
      log.info("re-activated floating routines after timezone change", { count });
    }
  }

  // Async to match the `RoutineEngine` surface a worker reaches over RPC; the
  // provider teardown below is synchronous, so this resolves immediately in the
  // main process.
  async deactivate(routineId: string): Promise<void> {
    for (const provider of this.providers.values()) {
      provider.deactivate(routineId);
    }
  }

  /** Fire a routine's action immediately, out of band from its trigger — the
   * "try run now" path. Reuses the same dispatch flow as a real fire (records a
   * routine_run, runs through the action engine, surfaces pending_approval), so
   * the run shows up in history exactly like a scheduled one. Differences from a
   * trigger fire: an empty payload (no trigger produced it), no `lastFiredAt`
   * bump (that's schedule bookkeeping), and no background retry on failure — a
   * manual run reports its outcome to the caller instead of queuing a retry.
   * Works regardless of `enabled` so a guardian can test a disabled routine.
   *
   * `payload` is the trigger payload to dispatch with — empty by default (a
   * "try run now" reproduces a bare fire). A caller can pass one to drive a
   * `manual` routine with input, surfaced to the action under
   * `__triggerPayload` exactly like a real trigger's payload. */
  async runNow(
    routineId: string,
    payload: Record<string, unknown> = {},
  ): Promise<{ runId: string; status: RoutineRunStatus; error?: string }> {
    const row = await this.routinesRepo.findById(routineId);
    if (!row) throw new Error(`routine not found: ${routineId}`);
    return this.dispatch(toRoutine(row), payload, { manual: true });
  }

  /** Stop a routine's running run(s), forcing each to a terminal "cancelled".
   * Handles both an in-flight run (best-effort kill of the action's subprocess;
   * dispatch's catch then records it cancelled, not error, and skips retry) and
   * a run left "running" after a restart (no process to kill — repair the status
   * directly). Two correctness points:
   *  - Cancels EVERY running run, not just the newest row: runs aren't serialized
   *    per routine, so an older run can still be live after a newer one finished.
   *  - Does NOT touch `pending_approval` runs. They have no live process, and
   *    marking them cancelled would be cosmetic — a later approval would still
   *    execute the action. Stopping those is the approval flow's responsibility.
   * Returns whether anything was stopped, and whether a live process was killed. */
  async cancelRun(routineId: string): Promise<{ stopped: boolean; killedLiveProcess: boolean }> {
    const running = await this.routineRunsRepo.findRunningByRoutineId(routineId);
    if (running.length === 0) {
      return { stopped: false, killedLiveProcess: false };
    }

    let killedLiveProcess = false;
    for (const run of running) {
      // Mark first so dispatch's catch (if this run is still in flight here)
      // treats the imminent rejection as a cancellation rather than a failure.
      this.cancellingExecutions.add(run.executionId);
      const killed = await this.actionEngine.cancel(run.executionId);
      if (killed) {
        killedLiveProcess = true;
      } else {
        // Nothing live to kill (stale run): drop the marker and repair the
        // status ourselves — no dispatch is awaiting to do it.
        this.cancellingExecutions.delete(run.executionId);
      }
      await this.routineRunsRepo.updateStatus(run.id, { status: "cancelled" });
    }

    log.info("routine runs cancelled", {
      routineId,
      count: running.length,
      killedLiveProcess,
    });
    return { stopped: true, killedLiveProcess };
  }

  private async dispatch(
    routine: Routine,
    payload: Record<string, unknown>,
    opts: { manual?: boolean } = {},
  ): Promise<{ runId: string; status: RoutineRunStatus; error?: string }> {
    const startTime = this.clock.now().getTime();

    // Pre-generate a rootExecutionId so the routine run links to the action
    // execution tree. The ActionEngine uses context.rootExecutionId when
    // provided instead of generating its own.
    const rootExecutionId = uuid();

    const runId = await this.routineRunsRepo.create({
      routineId: routine.id,
      executionId: rootExecutionId,
      status: "running",
      payload,
      firedBy: opts.manual ? "run_now" : routine.trigger.type,
    });

    // Captured inside the span callback and returned to the caller so a manual
    // "run now" can report the outcome. Defaults to error so an unexpected throw
    // before assignment surfaces as a failure rather than a silent success.
    let outcome: { status: RoutineRunStatus; error?: string } = { status: "error" };

    await withRomeSpan(
      `routine:${routine.name}`,
      {
        "rome.routine.id": routine.id,
        "rome.routine.name": routine.name,
        "rome.routine.trigger_type": routine.trigger.type,
        "rome.routine.action": routine.actionName,
      },
      async () => {
        log.info("routine fired", {
          routineId: routine.id,
          name: routine.name,
          action: routine.actionName,
        });

        const mergedArgs = { ...routine.args, __triggerPayload: payload };
        const context = {
          initiator: `routine:${routine.name}`,
          rootExecutionId,
        };

        try {
          const result = await runWithoutHookInvocationContext(() =>
            this.actionEngine.run(routine.actionName, mergedArgs, context),
          );
          const durationMs = this.clock.now().getTime() - startTime;

          // The action engine returns a structured `{status:"error"}` for a
          // domain failure that didn't throw (the catch below handles thrown
          // exceptions). Record it as a failed run rather than a silent success:
          // otherwise the run header reads "success" while the execution trace
          // shows the failing leaf. No background retry here — a returned error
          // is the action deliberately reporting failure, so only thrown
          // (transient) errors take the retry path.
          let status: RoutineRunStatus;
          if (result.status === "pending_approval") status = "pending_approval";
          else if (result.status === "error") status = "error";
          else status = "success";

          const error = result.status === "error" ? result.error : undefined;
          outcome = error !== undefined ? { status, error } : { status };
          await this.routineRunsRepo.updateStatus(runId, {
            status,
            durationMs,
            ...(error !== undefined ? { error } : {}),
          });

          if (status === "error") {
            log.warn("routine action returned an error", {
              routineId: routine.id,
              name: routine.name,
              error,
            });
          } else {
            log.info("routine execution succeeded", {
              routineId: routine.id,
              name: routine.name,
            });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const durationMs = this.clock.now().getTime() - startTime;

          // A guardian-requested stop kills the action's subprocess, which
          // surfaces here as a rejection. That's not a failure: record it as
          // cancelled and never retry. (cancelRun already nudged the row to
          // cancelled too; this keeps it consistent and stops the retry path.)
          if (this.cancellingExecutions.delete(rootExecutionId)) {
            outcome = { status: "cancelled" };
            await this.routineRunsRepo.updateStatus(runId, {
              status: "cancelled",
              durationMs,
            });
            log.info("routine run stopped by guardian", {
              routineId: routine.id,
              name: routine.name,
            });
          } else {
            outcome = { status: "error", error: errorMsg };
            await this.routineRunsRepo.updateStatus(runId, {
              status: "error",
              durationMs,
              error: errorMsg,
            });

            // A manual "run now" reports the failure to its caller; queuing a
            // background retry would surprise a guardian who just clicked once.
            if (opts.manual) {
              log.warn("manual routine run failed (no retry)", {
                routineId: routine.id,
                name: routine.name,
                error: errorMsg,
              });
            } else if (this.retryDelayMs > 0) {
              log.warn("routine execution failed, scheduling retry", {
                routineId: routine.id,
                name: routine.name,
                retryDelayMs: this.retryDelayMs,
                error: errorMsg,
              });

              const timer: ClockTimer = this.clock.setTimeout(() => {
                this.retryTimers.delete(timer);
                void withRomeSpan(
                  `routine_retry:${routine.name}`,
                  {
                    "rome.routine.id": routine.id,
                    "rome.routine.name": routine.name,
                    "rome.routine.action": routine.actionName,
                  },
                  async () => {
                    try {
                      await runWithoutHookInvocationContext(() =>
                        this.actionEngine.run(routine.actionName, mergedArgs, {
                          initiator: `routine:${routine.name}`,
                        }),
                      );
                      log.info("routine retry succeeded", {
                        routineId: routine.id,
                        name: routine.name,
                      });
                    } catch (retryErr) {
                      log.error("routine retry failed", {
                        routineId: routine.id,
                        name: routine.name,
                        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
                      });
                    }
                  },
                );
              }, this.retryDelayMs);
              this.retryTimers.add(timer);
            } else {
              log.warn("routine execution failed (retries disabled)", {
                routineId: routine.id,
                name: routine.name,
                error: errorMsg,
              });
            }
          }
        }

        // Only for real trigger fires — a manual "run now" is out of band from
        // the schedule, so bumping lastFiredAt here would misreport when the
        // routine last fired on its own.
        if (!opts.manual) {
          await this.routinesRepo.updateLastFired(routine.id, this.clock.now());
        }
      },
    );

    return { runId, ...outcome };
  }

  stop(): void {
    for (const provider of this.providers.values()) {
      provider.stop();
    }
    for (const timer of this.retryTimers) {
      this.clock.clearTimeout(timer);
    }
    this.retryTimers.clear();
    log.info("routine engine stopped");
  }
}
