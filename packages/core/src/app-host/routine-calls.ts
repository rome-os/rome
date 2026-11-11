// What Routines offers apps. An app's action worker runs in its own process
// and reaches the routine engine, which lives in the main process, through
// these calls.

import { z } from "zod";
import { toRoutine, type RoutinesRepository } from "../db/repositories/routines.js";
import { parseWorkerCallParams } from "../lib/worker-call-params.js";
import type { RoutineEngine } from "../routines/engine.js";

/** A call an app's worker makes on the main process: it takes the call's params and returns its result. */
export type WorkerCallHandler = (params: unknown) => Promise<unknown>;

const RoutineIdParams = z.object({ routineId: z.string().min(1) });

function routineIdOf(method: string, params: unknown): string {
  return parseWorkerCallParams(method, RoutineIdParams, params).routineId;
}

export interface RoutineWorkerCallsDeps {
  routinesRepo: Pick<RoutinesRepository, "findById">;
  routineEngine: Pick<RoutineEngine, "activate" | "deactivate">;
}

/** The routine calls an app's worker makes, keyed by method name. */
export function routineWorkerCalls(
  deps: RoutineWorkerCallsDeps,
): Record<string, WorkerCallHandler> {
  return {
    // Brings the engine in line with the stored routine: armed when enabled,
    // disarmed otherwise.
    "routines.schedule": async (params) => {
      const routineId = routineIdOf("routines.schedule", params);
      const row = await deps.routinesRepo.findById(routineId);
      if (!row) throw new Error(`Routine not found: ${routineId}`);
      if (row.enabled ?? true) {
        await deps.routineEngine.activate(toRoutine(row));
      } else {
        await deps.routineEngine.deactivate(routineId);
      }
      return { ok: true };
    },
    "routines.cancel": async (params) => {
      const routineId = routineIdOf("routines.cancel", params);
      await deps.routineEngine.deactivate(routineId);
      return { ok: true };
    },
  };
}
