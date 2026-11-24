// What agents do with a routine beyond creating, finding and deleting it: read
// what its runs did, pause or resume it, and run it now or stop its run. The
// Routines page reads the same records (runs.ts), makes the same change
// (update.ts) and calls the same engine. How a tool is declared:
// docs/concepts/actions.md#core-agent-tools.

import { z } from "zod";
import { agentToolsOf, toolError } from "../apps/actions/agent-tool.js";
import type { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { type RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import type { RoutineEngine } from "./engine.js";
import { startRoutineRun } from "./run-now.js";
import { type ActionTraceNode, listRoutineRuns, readRoutineRun } from "./runs.js";
import { updateRoutine } from "./update.js";

export interface RoutineToolDeps {
  routines: Pick<RoutinesRepository, "findById" | "update">;
  engine: Pick<RoutineEngine, "activate" | "deactivate" | "runNow" | "cancelRun">;
  routineRuns: Pick<RoutineRunsRepository, "findByRoutineId" | "findById">;
  actionExecutions: Pick<ActionExecutionsRepository, "findByRootExecutionIds">;
}

const agentTool = agentToolsOf<RoutineToolDeps>();

const routineId = z.string().describe("The routine's id, from search_routine.");

const DEFAULT_RUNS = 10;

export const listRoutineRunsTool = agentTool({
  name: "system:list_routine_runs",
  description:
    "Check what a routine did — whether it is on, when it last ran and runs next, and its recent runs newest first, each with its status (success, error, running, pending_approval or cancelled), time and error. Use it when the guardian asks whether a routine ran, failed or is due. Find the routine's id with system:search_routine",
  sideEffects: "read-only",
  input: z.object({
    routineId,
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("How many recent runs to return. Default 10."),
  }),
  run: async (input, { deps }) => {
    const id = input.routineId.trim();
    const row = id ? await deps.routines.findById(id) : null;
    if (!row) return toolError(notFound(id));
    const routine = toRoutine(row);
    const runs = await listRoutineRuns(deps, id, { limit: input.limit ?? DEFAULT_RUNS });
    return {
      routine: {
        id: routine.id,
        name: routine.name,
        enabled: routine.enabled,
        // Run now never sets lastFiredAt, so the newest run says when it last ran.
        lastRunAt: iso(runs[0]?.firedAt ?? routine.lastFiredAt),
        nextRunAt: iso(routine.nextRunAt),
      },
      runs: runs.map((run) => ({
        runId: run.id,
        status: run.status,
        firedAt: iso(run.firedAt),
        durationMs: run.durationMs ?? null,
        error: run.error ?? null,
      })),
    };
  },
});

export const readRoutineRunTool = agentTool({
  name: "system:read_routine_run",
  description:
    "Read one run of a routine — its status, its error, and every action it ran as a tree, with each action's status, error, duration and arguments (long ones cut short). Use it to explain why a run failed or what it did. Get the run's id from system:list_routine_runs",
  sideEffects: "read-only",
  input: z.object({
    routineId: z.string().describe("The routine's id."),
    runId: z.string().describe("The run's id, from list_routine_runs."),
  }),
  run: async (input, { deps }) => {
    const id = input.routineId.trim();
    const runId = input.runId.trim();
    const detail = id && runId ? await readRoutineRun(deps, id, runId) : null;
    if (!detail) {
      return toolError(
        `Routine "${id}" has no run "${runId}". List its runs with system:list_routine_runs.`,
      );
    }
    return { ...detail, roots: detail.roots.map(forAgent) };
  },
});

export const pauseRoutine = agentTool({
  name: "system:pause_routine",
  description:
    "Pause a routine — it stays saved but stops firing until resumed. Use it when the guardian asks to stop, pause or turn off a routine for now, rather than delete it. Only in the guardian's private chat, in a turn their own message started, so a routine cannot use it as its action. Find the routine's id with system:search_routine",
  sideEffects: "write",
  input: z.object({ routineId }),
  run: (input, { deps }) => setEnabled(deps, input.routineId, false),
});

export const resumeRoutine = agentTool({
  name: "system:resume_routine",
  description:
    "Turn a paused routine back on, so it fires on its schedule or event again. Use it when the guardian asks to resume or restart a routine. A one-off whose time has passed cannot come back on. Only in the guardian's private chat, in a turn their own message started, so a routine cannot use it as its action. Find the routine's id with system:search_routine",
  sideEffects: "write",
  input: z.object({ routineId }),
  run: (input, { deps }) => setEnabled(deps, input.routineId, true),
});

export const runRoutine = agentTool({
  name: "system:run_routine",
  description:
    "Run a routine now, as the Routines page's Run now does — its action runs for real, even when the routine is paused, and the run shows in its history. Use it when the guardian asks to run a routine, including a manual routine saved to run on demand. It answers once the run has started; check how it went with system:list_routine_runs. Only in the guardian's private chat, in a turn their own message started, so a routine cannot use it as its action. Find the routine's id with system:search_routine",
  sideEffects: "write",
  input: z.object({
    routineId,
    input: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Input for the run, passed to the routine's action as a trigger's would be. Omit for a plain run.",
      ),
  }),
  // Runs its action for real, even when the routine is paused, and answers
  // once the run has started; the run records its own outcome.
  run: async (input, { deps }) => {
    const id = input.routineId.trim();
    const row = id ? await deps.routines.findById(id) : null;
    if (!row) return toolError(notFound(id));
    const runId = await startRoutineRun(deps.engine, id, input.input ?? {});
    return { routineId: id, name: row.name, runId, started: true };
  },
});

export const stopRoutine = agentTool({
  name: "system:stop_routine",
  description:
    "Stop a routine's running run, as the Routines page's Stop does — each running run ends as cancelled. A run waiting for the guardian's approval is not stopped. The routine itself stays on; pause it with system:pause_routine to stop future runs. Only in the guardian's private chat, in a turn their own message started, so a routine cannot use it as its action",
  sideEffects: "write",
  input: z.object({ routineId }),
  run: async (input, { deps }) => {
    const id = input.routineId.trim();
    const row = id ? await deps.routines.findById(id) : null;
    if (!row) return toolError(notFound(id));
    const { stopped } = await deps.engine.cancelRun(id);
    return { routineId: id, name: row.name, stopped };
  },
});

/** The Routines page's agent tools beyond create, search and delete. */
export const routineTools = [
  listRoutineRunsTool,
  readRoutineRunTool,
  pauseRoutine,
  resumeRoutine,
  runRoutine,
  stopRoutine,
];

/** Turns the routine off or back on, by the Routines page's rule. */
async function setEnabled(deps: RoutineToolDeps, routineId: string, enabled: boolean) {
  const id = routineId.trim();
  if (!id) return toolError(notFound(id));
  const result = await updateRoutine({ routines: deps.routines, engine: deps.engine }, id, {
    enabled,
  });
  if (result.status === "not-found") return toolError(notFound(id));
  if (result.status === "refused") return toolError(result.error);
  const { routine } = result;
  return { routineId: routine.id, name: routine.name, enabled: routine.enabled };
}

const iso = (d: Date | undefined | null): string | null => (d ? d.toISOString() : null);

/** The longest an action's arguments run in a run's trace, as JSON. */
const MAX_ARGS_CHARS = 500;

/** What the agent needs of one action in a run: what ran, how it went and
 * with what, its arguments cut short. The Routines page reads the rest. */
interface AgentTraceNode {
  actionName: string;
  status: string;
  durationMs: number | null;
  error: string | null;
  args: string | null;
  children: AgentTraceNode[];
}

function forAgent(node: ActionTraceNode): AgentTraceNode {
  const args = node.args === undefined || node.args === null ? null : JSON.stringify(node.args);
  return {
    actionName: node.actionName,
    status: node.status,
    durationMs: node.durationMs,
    error: node.error,
    args: args && args.length > MAX_ARGS_CHARS ? `${args.slice(0, MAX_ARGS_CHARS)}…` : args,
    children: node.children.map(forAgent),
  };
}

function notFound(routineId: string): string {
  return routineId
    ? `No routine found with id "${routineId}". Use system:search_routine to find the right id.`
    : "Pass the routine's id as routineId. Find it with system:search_routine.";
}
