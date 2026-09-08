import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { createLedgerRepository } from "../../db/repositories/ledger.js";
import { createSettingsRepository } from "../../db/repositories/settings.js";

const log = createAppLogger("manager:run_worker");

/**
 * A worker, as this app can build one on today's platform.
 *
 * `system:summon` runs an agent to completion and returns its reply — there is
 * no detached mode and no way to stop a run. So the detachment lives one level
 * up: the runtime dispatches *this action* detached, and the action holds the
 * blocking summon for as long as it takes. The worker is a Rome execution the
 * runtime does not wait for, which is what the model asks for, even though the
 * summon inside it is ordinary and synchronous.
 *
 * The action writes the worker's own fact — Returned or Failed — because the
 * coding agent has no tools on this ledger and should not need any.
 */
export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task the worker is working on." },
        workerId: { type: "string", description: "Worker id from the task's Started fact." },
      },
      required: ["taskId", "workerId"],
      additionalProperties: true,
    },

    async execute(args): Promise<ActionResult> {
      const taskId = String(args.taskId ?? "");
      const workerId = String(args.workerId ?? "");
      if (!taskId || !workerId) {
        return { status: "error", error: "taskId and workerId are required" };
      }

      const settings = createSettingsRepository(appContext.db);
      const ledger = createLedgerRepository(appContext.db);

      const managerConfig = settings.get();
      if (!managerConfig) {
        return { status: "error", error: "manager is not configured. Run manager:setup first." };
      }

      // The prompt lives on the Started fact, so the worker reads its brief
      // from the ledger like everything else — this action carries no context
      // of its own from the pass that launched it.
      const started = ledger
        .factsFor(taskId)
        .find((fact) => fact.kind === "Started" && fact.payload.workerId === workerId);
      if (!started || started.kind !== "Started") {
        return {
          status: "error",
          error: `no Started fact for worker ${workerId} on task ${taskId}`,
        };
      }

      log.info("worker starting", { taskId, workerId, agent: managerConfig.workerAgent });

      let outcome: string;
      try {
        const result = await appContext.runAction("system:summon", {
          agentName: managerConfig.workerAgent,
          prompt: started.payload.prompt,
        });

        if (result.status === "ok") {
          const reply = readSummonReply(result.data);
          const written = ledger.appendWorkerOutcome({
            taskId,
            kind: "Returned",
            by: workerId,
            source: "manager:run_worker, on the worker's behalf",
            payload: { workerId, reply },
          });
          outcome = written ? "Returned" : "dropped (worker already closed)";
        } else {
          const error =
            result.status === "error" ? result.error : `summon returned ${result.status}`;
          const written = ledger.appendWorkerOutcome({
            taskId,
            kind: "Failed",
            by: workerId,
            source: "manager:run_worker, on the worker's behalf",
            payload: { workerId, error },
          });
          outcome = written ? "Failed" : "dropped (worker already closed)";
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const written = ledger.appendWorkerOutcome({
          taskId,
          kind: "Failed",
          by: workerId,
          source: "manager:run_worker, on the worker's behalf",
          payload: { workerId, error },
        });
        outcome = written ? "Failed" : "dropped (worker already closed)";
      }

      log.info("worker finished", { taskId, workerId, outcome });

      // A new fact exists, so the runtime reconciles now rather than waiting
      // for the next tick.
      await appContext.runAction("manager:reconcile", {});

      return { status: "ok", data: { taskId, workerId, outcome } };
    },
  };
}

/** `system:summon` returns `{ result, sessionId, romeSession }`. */
function readSummonReply(data: unknown): string {
  if (typeof data === "object" && data !== null) {
    const result = (data as { result?: unknown }).result;
    if (typeof result === "string") return result;
  }
  return "";
}
