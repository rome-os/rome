// What Routines offers apps. An app's action worker runs in its own process
// and reaches the routine engine, which lives in the main process, through
// these calls.

import { z } from "zod";
import { resolveArtifactId, type LegacyArtifactBindings } from "../apps/artifact-id.js";
import { toRoutine, type RoutinesRepository } from "../db/repositories/routines.js";
import { parseWorkerCallParams } from "../lib/worker-call-params.js";
import type { RoutineEngine } from "./engine.js";

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

export interface AppRoutinePauserDeps {
  legacyBindings: Readonly<LegacyArtifactBindings>;
  repository: Pick<RoutinesRepository, "findEnabled" | "update">;
  engine: Pick<RoutineEngine, "deactivate">;
}

/**
 * Pauses every enabled routine that fires one of an app's actions, named by
 * its qualified name or a legacy binding. Apps calls it when the app is
 * disabled, uninstalled or removed at boot.
 */
export function appRoutinePauser(deps: AppRoutinePauserDeps): (appId: string) => Promise<void> {
  return async (appId) => {
    const prefix = `${appId}:`;
    for (const routine of await deps.repository.findEnabled()) {
      let actionName = routine.actionName;
      if (!actionName.startsWith(prefix)) {
        try {
          actionName = resolveArtifactId({
            kind: "action",
            value: actionName,
            legacyBindings: deps.legacyBindings,
          });
        } catch {
          continue;
        }
        if (!actionName.startsWith(prefix)) continue;
      }
      await deps.repository.update(routine.id, { enabled: false });
      await deps.engine.deactivate(routine.id);
    }
  };
}
