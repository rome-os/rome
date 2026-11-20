// Which routines stop when an app goes away. A routine that fires one of an
// app's actions cannot run once the app is disabled, uninstalled or removed at
// boot, so Routines pauses it. Once the app is uninstalled, the routines it
// managed are deleted.

import type { RoutinesRepository } from "../db/repositories/routines.js";
import type { RoutineEngine } from "./engine.js";

export interface AppRoutinePauserDeps {
  repository: Pick<RoutinesRepository, "findEnabled" | "update">;
  engine: Pick<RoutineEngine, "deactivate">;
}

/**
 * Pauses every enabled routine that fires one of an app's actions. The routine
 * is disabled in the database before the engine deactivates it, so one paused
 * at boot stays paused when the engine starts.
 */
export function appRoutinePauser(deps: AppRoutinePauserDeps): (appId: string) => Promise<void> {
  return async (appId) => {
    const prefix = `${appId}:`;
    for (const routine of await deps.repository.findEnabled()) {
      if (!routine.actionName.startsWith(prefix)) continue;
      await deps.repository.update(routine.id, { enabled: false });
      await deps.engine.deactivate(routine.id);
    }
  };
}

export interface RemovedAppRoutinesDeps {
  repository: Pick<RoutinesRepository, "managingAppIds" | "deleteManagedRoutines">;
  /** The app's lockfile entry, the authoritative record that it is installed. */
  readLockfileEntry: (appId: string) => Promise<unknown>;
}

/**
 * Deletes the routines of every managing app with no lockfile entry, and
 * returns those apps. The lockfile is read rather than the catalog, which is
 * incomplete when app boot fails, because a deleted routine can't be restored.
 */
export async function deleteRoutinesOfRemovedApps(
  deps: RemovedAppRoutinesDeps,
): Promise<{ apps: string[]; deleted: number; kept: number }> {
  const apps: string[] = [];
  for (const appId of await deps.repository.managingAppIds()) {
    if ((await deps.readLockfileEntry(appId)) == null) apps.push(appId);
  }
  const { deleted, kept } = await deps.repository.deleteManagedRoutines(apps);
  return { apps, deleted: deleted.length, kept };
}
