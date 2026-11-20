import type { Action, ActionConfig, ActionResult } from "@rome-os/app-runtime";

// ---------------------------------------------------------------------------
// Dependencies injected via factory
// ---------------------------------------------------------------------------

/** The single capability this action needs: ask the main-process upgrade
 * service to probe Rome Cloud and, if a release is pending, open the consent
 * countdown. Defined structurally (rather than imported from core) because the
 * action can't reach core internals — the runtime injects the real
 * `SystemUpgradeService` in the main process, or its WorkerRPC proxy in a
 * worker, and both satisfy this shape. */
export interface SystemUpgradeChecker {
  checkAndOffer(): Promise<{ pending: boolean; targetVersion?: string }>;
}

export interface SystemUpgradeDeps {
  systemUpgrade: SystemUpgradeChecker;
}

// ---------------------------------------------------------------------------
// Factory: createSystemUpgradeAction
// ---------------------------------------------------------------------------

export function createSystemUpgradeAction(config: ActionConfig, deps: SystemUpgradeDeps): Action {
  return {
    config,
    // No inputSchema — fired by the nightly system_upgrade routine, not the agent.
    async execute(): Promise<ActionResult> {
      const result = await deps.systemUpgrade.checkAndOffer();
      return { status: "ok", data: result };
    },
  };
}

export function createAction(config: ActionConfig, deps: SystemUpgradeDeps): Action {
  // Fail the action load at boot if the dep is missing, rather than surfacing a
  // TypeError on the first 3am fire.
  if (typeof deps.systemUpgrade?.checkAndOffer !== "function") {
    throw new Error("system:system_upgrade requires a systemUpgrade dep with checkAndOffer()");
  }
  return createSystemUpgradeAction(config, deps);
}
