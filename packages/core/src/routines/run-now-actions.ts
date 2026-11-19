// The agent's way to run a routine by hand and to stop its run:
// `core:routine_run_now` and `core:routine_stop`, through the same engine calls
// as the Routines page's Run now and Stop buttons.

import type { ActionRegistry } from "../apps/actions/types.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import { createLogger } from "../logger.js";
import type { RoutineEngine } from "./engine.js";
import { ROUTINE_RUNS_LIST_ACTION } from "./run-actions.js";
import { changeRefusal } from "./turn-access.js";

const log = createLogger("routine-run-now");

export const ROUTINE_RUN_NOW_ACTION = "core:routine_run_now";
export const ROUTINE_STOP_ACTION = "core:routine_stop";

export interface RoutineRunNowActionDeps {
  routines: Pick<RoutinesRepository, "findById">;
  engine: Pick<RoutineEngine, "runNow" | "cancelRun">;
}

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

const notFound = (routineId: string) => ({
  status: "error" as const,
  error: routineId
    ? `No routine found with id "${routineId}". Use system:search_routine to find the right id.`
    : "Pass the routine's id as routineId. Find it with system:search_routine.",
});

const idOf = (args: Record<string, unknown>) =>
  typeof args.routineId === "string" ? args.routineId.trim() : "";

/** Registers running a routine now and stopping its run. */
export function registerRoutineRunNowActions(
  actions: Pick<ActionRegistry, "register">,
  deps: RoutineRunNowActionDeps,
): void {
  actions.register({
    config: {
      name: ROUTINE_RUN_NOW_ACTION,
      type: "system",
      description: `Run a routine now, as the Routines page's Run now does: its action runs for real, even when the routine is paused, and the run shows in its history. Use it when the guardian asks to run a routine, including a manual routine saved to run on demand. It answers once the run has started; check how it went with ${ROUTINE_RUNS_LIST_ACTION}. Only in the guardian's private chat, in a turn their own message started. Find the routine's id with system:search_routine.`,
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    inputSchema: {
      type: "object",
      required: ["routineId"],
      properties: {
        routineId: { type: "string", description: "The routine's id, from system:search_routine." },
        input: {
          type: "object",
          description:
            "Input for the run, passed to the routine's action as a trigger's would be. Omit for a plain run.",
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const refusal = changeRefusal();
      if (refusal) return { status: "error", error: refusal };
      const routineId = idOf(args);
      const row = routineId ? await deps.routines.findById(routineId) : null;
      if (!row) return notFound(routineId);
      const input =
        args.input && typeof args.input === "object" && !Array.isArray(args.input)
          ? (args.input as Record<string, unknown>)
          : {};
      const runId = await startRoutineRun(deps.engine, routineId, input);
      return { status: "ok", data: { routineId, name: row.name, runId, started: true } };
    },
  });

  actions.register({
    config: {
      name: ROUTINE_STOP_ACTION,
      type: "system",
      description:
        "Stop a routine's running run, as the Routines page's Stop does: each running run ends as cancelled. A run waiting for the guardian's approval is not stopped. The routine itself stays on; pause it with core:routine_pause to stop future runs. Only in the guardian's private chat, in a turn their own message started.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    inputSchema: {
      type: "object",
      required: ["routineId"],
      properties: {
        routineId: { type: "string", description: "The routine's id, from system:search_routine." },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const refusal = changeRefusal();
      if (refusal) return { status: "error", error: refusal };
      const routineId = idOf(args);
      const row = routineId ? await deps.routines.findById(routineId) : null;
      if (!row) return notFound(routineId);
      const { stopped } = await deps.engine.cancelRun(routineId);
      return { status: "ok", data: { routineId, name: row.name, stopped } };
    },
  });
}
