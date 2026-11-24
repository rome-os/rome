// What agents do with a routine beyond creating and deleting it: see the
// routines and their runs, change one, pause or resume it, and run it now or
// stop its run. The Routines page reads the same records (list.ts, runs.ts),
// makes the same changes (update.ts) and calls the same engine. How a tool is
// declared: docs/concepts/actions.md#core-agent-tools.

import { z } from "zod";
import { agentToolsOf, toolError } from "../apps/actions/agent-tool.js";
import type { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { type RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import { type CreateRoutineDeps, createRoutineInputSchema } from "./create.js";
import type { RoutineEngine } from "./engine.js";
import { listRoutinesWithLastRun } from "./list.js";
import { startRoutineRun } from "./run-now.js";
import { type ActionTraceNode, listRoutineRuns, readRoutineRun } from "./runs.js";
import { changeRoutine, updateRoutine } from "./update.js";

export interface RoutineToolDeps
  extends Pick<
    CreateRoutineDeps,
    "actionRegistry" | "agentRunner" | "resolveOneOffDate" | "hasTriggerType"
  > {
  routines: Pick<RoutinesRepository, "findAll" | "findById" | "update">;
  engine: Pick<RoutineEngine, "activate" | "deactivate" | "runNow" | "cancelRun">;
  routineRuns: Pick<
    RoutineRunsRepository,
    "findByRoutineId" | "findById" | "findLatestByRoutineIds"
  >;
  actionExecutions: Pick<ActionExecutionsRepository, "findByRootExecutionIds">;
}

const agentTool = agentToolsOf<RoutineToolDeps>();

const routineId = z.string().describe("The routine's id, from system:read_routines.");

const DEFAULT_RUNS = 10;

const runsLimit = z
  .number()
  .int()
  .min(1)
  .max(50)
  .optional()
  .describe("How many recent runs to return. Default 10.");

export const readRoutines = agentTool({
  name: "system:read_routines",
  olderNames: ["system:list_routine_runs", "system:read_routine_run"],
  description:
    "See the guardian's routines, one routine, or one of its runs, as the Routines page shows them. Use it when the guardian asks what routines they have, what a routine does and when it runs, whether it ran, failed or is due, or why a run failed. With no id it lists every routine with what it runs, when, whether it is on and how its latest run went. With a routineId it returns that routine in full with its recent runs, newest first. With a routineId and a runId it returns that run with every action it ran",
  sideEffects: "read-only",
  input: z.object({
    routineId: routineId
      .optional()
      .describe("The routine to read in full, from this tool's list. Omit to list every routine."),
    runId: z
      .string()
      .optional()
      .describe("One run of that routine to read in full, from its runs. Needs routineId."),
    limit: runsLimit,
  }),
  run: async (input, { deps }) => {
    const id = input.routineId?.trim();
    const runId = input.runId?.trim();
    if (!id) {
      if (runId) return toolError("Pass the run's routine as routineId with the runId.");
      const listed = await listRoutinesWithLastRun(deps);
      return {
        routines: listed.map(({ row, lastRun }) => {
          const routine = toRoutine(row);
          return {
            routineId: routine.id,
            // Apps that read routines through ctx.runAction may still read `id`.
            id: routine.id,
            name: routine.name,
            enabled: routine.enabled,
            ...(routine.managedBy ? { managedBy: routine.managedBy } : {}),
            actionName: routine.actionName,
            trigger: routine.trigger,
            lastRun: lastRun ? { status: lastRun.status, firedAt: iso(lastRun.firedAt) } : null,
          };
        }),
      };
    }
    if (runId) return readRun(deps, id, runId);
    return routineWithRuns(deps, id, input.limit);
  },
});

export const changeRoutineTool = agentTool({
  name: "system:change_routine",
  description:
    "Change a routine the guardian already has: rename it, change what it does (its action or that action's arguments), or change when it runs (its schedule or the event it waits for). Use it when the guardian asks to move a reminder to another time, run a routine on other days, change its message or task, or give it another name. Pass only what changes; read the routine first with system:read_routines to see what it does now. To turn it off or on use system:pause_routine or system:resume_routine. A routine an app manages keeps what it runs and when. Only in the guardian's private chat, in a turn their own message started, so a routine cannot use it as its action",
  sideEffects: "write",
  input: z.object({
    routineId,
    name: z.string().optional().describe("The routine's new name. Omit to keep it."),
    actionName: createRoutineInputSchema.shape.actionName
      .optional()
      .describe("The full id of the action it runs from now on. Omit to keep it."),
    args: createRoutineInputSchema.shape.args.describe(
      "The whole argument object its action gets from now on, replacing the old one. Omit to keep it.",
    ),
    trigger: createRoutineInputSchema.shape.trigger
      .optional()
      .describe("When it runs from now on, replacing its old trigger. Omit to keep it."),
  }),
  run: async (input, { deps }) => {
    const id = input.routineId.trim();
    if (!id) return toolError(notFound(id));
    const { routineId: _id, ...request } = input;
    if (Object.values(request).every((value) => value === undefined)) {
      return toolError("Pass what changes: name, actionName, args or trigger.");
    }
    const result = await changeRoutine(deps, id, request);
    if (result.status === "not-found") return toolError(notFound(id));
    if (result.status === "refused") return toolError(result.error);
    const { routine } = result;
    return {
      routineId: routine.id,
      name: routine.name,
      enabled: routine.enabled,
      actionName: routine.actionName,
      args: routine.args,
      trigger: routine.trigger,
    };
  },
});

/** Older name of `system:read_routines` with a routineId, which saved
 * routines and agents may still call. */
export const listRoutineRunsTool = agentTool({
  name: "system:list_routine_runs",
  description:
    "A routine's state and recent runs. Kept for older callers: use system:read_routines with the routine's id instead",
  sideEffects: "read-only",
  input: z.object({ routineId, limit: runsLimit }),
  run: (input, { deps }) => routineWithRuns(deps, input.routineId.trim(), input.limit),
});

/** Older name of `system:read_routines` with a routineId and a runId. */
export const readRoutineRunTool = agentTool({
  name: "system:read_routine_run",
  description:
    "One run of a routine with every action it ran. Kept for older callers: use system:read_routines with the routine's id and the run's id instead",
  sideEffects: "read-only",
  input: z.object({
    routineId: z.string().describe("The routine's id."),
    runId: z.string().describe("The run's id, from system:read_routines."),
  }),
  run: (input, { deps }) => readRun(deps, input.routineId.trim(), input.runId.trim()),
});

export const pauseRoutine = agentTool({
  name: "system:pause_routine",
  description:
    "Pause a routine — it stays saved but stops firing until resumed. Use it when the guardian asks to stop, pause or turn off a routine for now, rather than delete it. Only in the guardian's private chat, in a turn their own message started, so a routine cannot use it as its action. Find the routine's id with system:read_routines",
  sideEffects: "write",
  input: z.object({ routineId }),
  run: (input, { deps }) => setEnabled(deps, input.routineId, false),
});

export const resumeRoutine = agentTool({
  name: "system:resume_routine",
  description:
    "Turn a paused routine back on, so it fires on its schedule or event again. Use it when the guardian asks to resume or restart a routine. A one-off whose time has passed cannot come back on. Only in the guardian's private chat, in a turn their own message started, so a routine cannot use it as its action. Find the routine's id with system:read_routines",
  sideEffects: "write",
  input: z.object({ routineId }),
  run: (input, { deps }) => setEnabled(deps, input.routineId, true),
});

export const runRoutine = agentTool({
  name: "system:run_routine",
  description:
    "Run a routine now, as the Routines page's Run now does — its action runs for real, even when the routine is paused, and the run shows in its history. Use it when the guardian asks to run a routine, including a manual routine saved to run on demand. It answers once the run has started; check how it went with system:read_routines. Only in the guardian's private chat, in a turn their own message started, so a routine cannot use it as its action. Find the routine's id with system:read_routines",
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

export const stopRoutineRun = agentTool({
  name: "system:stop_routine_run",
  olderNames: ["system:stop_routine"],
  description:
    "Stop a routine's run that is in progress, as the Routines page's Stop does — each running run ends as cancelled. Use it when the guardian asks to stop or cancel what a routine is doing right now. A run waiting for the guardian's approval is not stopped. The routine itself stays on; pause it with system:pause_routine to stop future runs. Only in the guardian's private chat, in a turn their own message started, so a routine cannot use it as its action. Find the routine's id with system:read_routines",
  sideEffects: "write",
  input: z.object({ routineId }),
  run: (input, { deps }) => stopRun(deps, input.routineId),
});

/** Older name of `system:stop_routine_run`, which saved routines and agents
 * may still call. */
export const stopRoutine = agentTool({
  name: "system:stop_routine",
  description:
    "Stop a routine's running run. Kept for older callers: use system:stop_routine_run instead. Only in the guardian's private chat, in a turn their own message started",
  sideEffects: "write",
  input: z.object({ routineId }),
  run: (input, { deps }) => stopRun(deps, input.routineId),
});

/** The Routines page's agent tools beyond create and delete, with the older
 * names that still work. */
export const routineTools = [
  readRoutines,
  changeRoutineTool,
  pauseRoutine,
  resumeRoutine,
  runRoutine,
  stopRoutineRun,
  listRoutineRunsTool,
  readRoutineRunTool,
  stopRoutine,
];

/** A routine in full with its recent runs, newest first. */
async function routineWithRuns(deps: RoutineToolDeps, id: string, limit: number | undefined) {
  const row = id ? await deps.routines.findById(id) : null;
  if (!row) return toolError(notFound(id));
  const routine = toRoutine(row);
  const runs = await listRoutineRuns(deps, id, { limit: limit ?? DEFAULT_RUNS });
  return {
    routine: {
      routineId: routine.id,
      id: routine.id,
      name: routine.name,
      enabled: routine.enabled,
      ...(routine.managedBy ? { managedBy: routine.managedBy } : {}),
      actionName: routine.actionName,
      args: routine.args,
      trigger: routine.trigger,
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
}

/** One run with the actions it ran, their arguments cut short. */
async function readRun(deps: RoutineToolDeps, id: string, runId: string) {
  const detail = id && runId ? await readRoutineRun(deps, id, runId) : null;
  if (!detail) {
    return toolError(
      `Routine "${id}" has no run "${runId}". See its runs with system:read_routines and its routineId.`,
    );
  }
  return { ...detail, roots: detail.roots.map(forAgent) };
}

/** Ends each running run of the routine as cancelled, as the page's Stop does. */
async function stopRun(deps: RoutineToolDeps, routineId: string) {
  const id = routineId.trim();
  const row = id ? await deps.routines.findById(id) : null;
  if (!row) return toolError(notFound(id));
  const { stopped } = await deps.engine.cancelRun(id);
  return { routineId: id, name: row.name, stopped };
}

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
    ? `No routine found with id "${routineId}". Use system:read_routines to find the right id.`
    : "Pass the routine's id as routineId. Find it with system:read_routines.";
}
