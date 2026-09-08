import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { createLedgerRepository, type LedgerRepository } from "../../db/repositories/ledger.js";
import { createLockRepository, RECONCILE_LOCK } from "../../db/repositories/lock.js";
import { createSettingsRepository } from "../../db/repositories/settings.js";
import { RUNTIME } from "../../lib/facts.js";
import { fold } from "../../lib/fold.js";
import { judge } from "../../lib/judge.js";
import { LOST_STOPPED, reconcile, type ReconcileAction } from "../../lib/reconcile.js";

const log = createAppLogger("manager:reconcile");

/**
 * How long a pass may hold the lock. Long enough that a slow pass is never cut
 * off mid-list, short enough that a killed process does not stall the loop for
 * more than a couple of scheduled ticks.
 */
const LOCK_LEASE_MS = 5 * 60_000;

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;

  return {
    config,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },

    async execute(): Promise<ActionResult> {
      const settings = createSettingsRepository(appContext.db);
      const ledger = createLedgerRepository(appContext.db);
      const locks = createLockRepository(appContext.db);

      // No ledger, no pass. Nothing is written and nothing is inferred from
      // anywhere else; the next tick tries again.
      if (!ledger.reachable()) {
        log.warn("ledger unreachable; skipping");
        return { status: "ok", data: { skipped: "ledger unreachable" } };
      }

      const managerConfig = settings.get();
      if (!managerConfig) {
        return { status: "error", error: "manager is not configured. Run manager:setup first." };
      }

      // A second pass arriving while one runs returns immediately; the pass
      // that holds the lock, or the next tick, sees whatever it missed.
      if (!locks.tryAcquire(RECONCILE_LOCK, LOCK_LEASE_MS)) {
        return { status: "ok", data: { skipped: "another reconcile is running" } };
      }

      try {
        const snapshot = fold(new Date(), ledger.all());
        const actions = reconcile({
          snapshot,
          config: managerConfig,
          judge,
          newWorkerId: () => `w-${crypto.randomUUID().slice(0, 8)}`,
        });

        const applied: string[] = [];
        for (const action of actions) {
          applied.push(await apply(action, ledger, appContext));
        }

        log.info("reconcile finished", { tasks: snapshot.tasks.length, applied: applied.length });
        return { status: "ok", data: { tasks: snapshot.tasks.length, applied } };
      } finally {
        locks.release(RECONCILE_LOCK);
      }
    },
  };
}

/**
 * Carry out one item from reconcile's list. The order matters: a Started is
 * appended before its worker is launched, so a pass that dies in between leaves
 * a worker the next pass can see rather than one it cannot.
 */
async function apply(
  action: ReconcileAction,
  ledger: LedgerRepository,
  appContext: AppActionRuntimeDeps["appContext"],
): Promise<string> {
  switch (action.type) {
    case "append": {
      const fact = ledger.append(action.fact);
      return `${fact.kind}(${fact.taskId})`;
    }

    case "launch": {
      // Detached, so the worker's run is a root execution with its own
      // lifetime: this pass returns as soon as main accepts it.
      const receipt = await appContext.runAction(
        "manager:run_worker",
        { taskId: action.taskId, workerId: action.workerId },
        { detached: true },
      );
      log.info("worker launched", { ...action, executionId: receipt.executionId });
      return `launch(${action.workerId})`;
    }

    case "stop": {
      // Rome has no app-facing way to cancel a detached execution or an agent
      // session, so the runtime records the stop it intended and stops reading
      // that worker. The worker itself runs on; `appendWorkerOutcome` drops its
      // late reply because this Lost already closed it.
      ledger.append({
        taskId: action.taskId,
        kind: "Lost",
        by: RUNTIME,
        payload: { workerId: action.workerId, why: action.why },
      });
      log.warn("worker stop recorded as Lost", { ...action, gap: LOST_STOPPED });
      return `stop(${action.workerId})`;
    }
  }
}
