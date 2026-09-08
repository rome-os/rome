import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { createLedgerRepository } from "../../db/repositories/ledger.js";
import { describeFact } from "../../lib/facts.js";
import { fold } from "../../lib/fold.js";

/** How many recent facts each task carries into the summary. */
const HISTORY_LINES = 6;

/**
 * The ledger as the manager agent sees it: enough to tell which task a person's
 * words are about, and nothing about how the runtime decides anything.
 */
export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        includeClosed: {
          type: "boolean",
          description: "Include completed and cancelled tasks. Defaults to false.",
        },
      },
      additionalProperties: false,
    },

    async execute(args): Promise<ActionResult> {
      const includeClosed = args.includeClosed === true;
      const ledger = createLedgerRepository(appContext.db);
      if (!ledger.reachable()) {
        return { status: "error", error: "the ledger is unreachable" };
      }

      const snapshot = fold(new Date(), ledger.all());
      const tasks = snapshot.tasks
        .filter(
          (task) => includeClosed || (task.state !== "completed" && task.state !== "cancelled"),
        )
        .map((task) => ({
          id: task.id,
          brief: task.brief,
          state: task.state,
          position: task.position,
          workerRunning: task.liveWorker?.workerId,
          history: task.facts.slice(-HISTORY_LINES).map(describeFact),
        }));

      return { status: "ok", data: { tasks } };
    },
  };
}
