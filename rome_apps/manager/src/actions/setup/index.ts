import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AppActionRuntimeDeps,
  type RomeAppContext,
} from "@rome-os/app-runtime";
import { createSettingsRepository } from "../../db/repositories/settings.js";
import {
  DEFAULT_AGE_CAP_HOURS,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_MAX_WORKERS,
  DEFAULT_START_CAP,
  DEFAULT_WORKER_AGENT,
  type ManagerConfig,
  parseConfig,
  RECONCILE_ROUTINE_KEY,
  RECONCILE_ROUTINE_NAME,
  reconcileTrigger,
} from "../../lib/config.js";

const log = createAppLogger("manager:setup");

/** What `setup` did to the routine, reported back to the guardian. */
export type RoutineOutcome = "created" | "replaced" | "unchanged";

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        workingDir: {
          type: "string",
          description: "Absolute path of the directory every worker works in.",
        },
        workerAgent: {
          type: "string",
          description: `Canonical id of the agent a worker runs. Defaults to ${DEFAULT_WORKER_AGENT}.`,
        },
        startCap: {
          type: "number",
          description: `Workers one task may be given since the last thing a person said, before the runtime asks them a question. Defaults to ${DEFAULT_START_CAP}.`,
        },
        maxWorkers: {
          type: "number",
          description: `Workers allowed to run at once across every task. Defaults to ${DEFAULT_MAX_WORKERS}.`,
        },
        ageCapHours: {
          type: "number",
          description: `Hours a worker may be silent before it is declared lost. Defaults to ${DEFAULT_AGE_CAP_HOURS}.`,
        },
        intervalMinutes: {
          type: "number",
          description: `How often the reconcile routine fires. Defaults to ${DEFAULT_INTERVAL_MINUTES}.`,
        },
      },
      required: ["workingDir"],
      additionalProperties: true,
    },

    async execute(args): Promise<ActionResult> {
      const parsed = parseConfig(args);
      if (!parsed.ok) return { status: "error", error: parsed.error };

      createSettingsRepository(appContext.db).put(parsed.config);

      const routine = await ensureRoutine(appContext, parsed.config);
      if (!routine.ok) return { status: "error", error: routine.error };

      log.info("setup finished", { config: parsed.config, routine: routine.outcome });
      return { status: "ok", data: { config: parsed.config, routine: routine.outcome } };
    },
  };
}

/**
 * Register the reconcile routine, once. `create_routine` is not idempotent, so
 * the guard is the routine `key` — Rome enforces it as unique, unlike the
 * display name. A cadence change is a delete and a re-create, because a trigger
 * cannot be edited in place.
 */
async function ensureRoutine(
  appContext: RomeAppContext,
  config: ManagerConfig,
): Promise<{ ok: true; outcome: RoutineOutcome } | { ok: false; error: string }> {
  const trigger = reconcileTrigger(config.intervalMinutes);
  const existing = (await appContext.listRoutines()).find(
    (routine) => routine.key === RECONCILE_ROUTINE_KEY || routine.name === RECONCILE_ROUTINE_NAME,
  );

  if (existing) {
    const current = existing.trigger as { rrule?: string };
    if (current.rrule === trigger.rrule) {
      return { ok: true, outcome: "unchanged" };
    }
    const deleted = await appContext.runAction("system:delete_routine", {
      routineId: existing.id,
    });
    if (deleted.status !== "ok") {
      const reason = deleted.status === "error" ? deleted.error : `returned ${deleted.status}`;
      return { ok: false, error: `could not replace the reconcile routine: ${reason}` };
    }
  }

  const created = await appContext.runAction("system:create_routine", {
    name: RECONCILE_ROUTINE_NAME,
    key: RECONCILE_ROUTINE_KEY,
    trigger,
    actionName: "manager:reconcile",
    args: {},
  });
  if (created.status !== "ok") {
    const reason = created.status === "error" ? created.error : `returned ${created.status}`;
    return { ok: false, error: `could not register the reconcile routine: ${reason}` };
  }

  return { ok: true, outcome: existing ? "replaced" : "created" };
}
