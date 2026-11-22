// Running a routine now from an action, as the Routines page's Run now does,
// but answering once the run has started rather than when it ends.

import { createLogger } from "../logger.js";
import type { RoutineEngine } from "./engine.js";

const log = createLogger("routine-run-now");

/** Starts a run of the routine now and answers with its id once it has
 * started; the run goes on and records its own outcome. Rejects when the
 * routine does not exist. */
export function startRoutineRun(
  engine: Pick<RoutineEngine, "runNow">,
  routineId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    engine.runNow(routineId, payload, resolve).then(
      (outcome) => resolve(outcome.runId),
      (err: unknown) => {
        // After the start the run records its own failure, so a later
        // rejection only needs a log line.
        log.warn("routine run failed", {
          routineId,
          error: err instanceof Error ? err.message : String(err),
        });
        reject(err);
      },
    );
  });
}
