// Which routines stop when an app goes away. A routine that fires one of an
// app's actions cannot run once the app is disabled, uninstalled or removed at
// boot, so Routines pauses it.

import { resolveArtifactId, type LegacyArtifactBindings } from "../apps/artifact-id.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type { RoutineEngine } from "./engine.js";

export interface AppRoutinePauserDeps {
  legacyBindings: Readonly<LegacyArtifactBindings>;
  repository: Pick<RoutinesRepository, "findEnabled" | "update">;
  engine: Pick<RoutineEngine, "deactivate">;
}

/**
 * Pauses every enabled routine that fires one of an app's actions, named by its
 * qualified name or a legacy binding. The routine is disabled in the database
 * before the engine deactivates it, so one paused at boot stays paused when the
 * engine starts.
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
