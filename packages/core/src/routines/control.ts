// What agents and apps do with a routine through the system app's routine
// actions, beyond creating, finding and deleting it: read what its runs did,
// pause or resume it, and run it now or stop its run. The Routines page reads
// the same records (runs.ts), makes the same change (update.ts) and calls the
// same engine. The main process runs
// these operations; an action worker reaches them over the `routines.control`
// worker call (app-host/routine-calls.ts).

import type { SessionActor } from "../access/session-actor.js";
import { actionExecutionContext } from "../apps/actions/context.js";
import type { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import type { ThreadContext } from "../core/types.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { type RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import type { RoutineEngine } from "./engine.js";
import { startRoutineRun } from "./run-now.js";
import { type ActionTraceNode, listRoutineRuns, readRoutineRun } from "./runs.js";
import { changeRefusal, type OwnerOfChat, turnWorksForGuardian } from "./turn-access.js";
import { updateRoutine } from "./update.js";

/** The turn an operation runs for: who it acts for, who can read it, and where. */
export interface RoutineTurn {
  actor?: SessionActor;
  audience?: "private" | "shared";
  channelContext?: ThreadContext;
}

export type RoutineControlResult =
  | { status: "ok"; data: unknown }
  | { status: "error"; error: string };

export const ROUTINE_CONTROL_OPS = [
  "listRuns",
  "readRun",
  "pause",
  "resume",
  "runNow",
  "stop",
] as const;
export type RoutineControlOp = (typeof ROUTINE_CONTROL_OPS)[number];

/** Each operation, for the turn that asks for it. */
export type RoutineOperations = Record<
  RoutineControlOp,
  (input: unknown, turn: RoutineTurn) => Promise<RoutineControlResult>
>;

/** The operations as the system app's actions reach them: the main process's
 * own, or a worker's call to it. */
export interface RoutineControlService {
  call(op: RoutineControlOp, input: unknown): Promise<RoutineControlResult>;
}

/** The turn of the running action. */
export function runningTurn(): RoutineTurn {
  const store = actionExecutionContext.getStore();
  return {
    ...(store?.actor ? { actor: store.actor } : {}),
    ...(store?.audience ? { audience: store.audience } : {}),
    ...(store?.channelContext ? { channelContext: store.channelContext } : {}),
  };
}

/** Runs each operation for the turn of the action that calls it. */
export function routineControlService(operations: RoutineOperations): RoutineControlService {
  return { call: (op, input) => operations[op](input, runningTurn()) };
}

export interface RoutineOperationDeps {
  routines: Pick<RoutinesRepository, "findById" | "update">;
  engine: Pick<RoutineEngine, "activate" | "deactivate" | "runNow" | "cancelRun">;
  routineRuns: Pick<RoutineRunsRepository, "findByRoutineId" | "findById">;
  actionExecutions: Pick<ActionExecutionsRepository, "findByRootExecutionIds">;
  ownerOfChat: OwnerOfChat;
}

const DEFAULT_RUNS = 10;
const MAX_RUNS = 50;

const iso = (d: Date | undefined | null): string | null => (d ? d.toISOString() : null);

const READ_REFUSED = {
  status: "error" as const,
  error: "Only the guardian's agents can read routines.",
};

/** The routine operations, over the repositories and the engine. */
export function routineOperations(deps: RoutineOperationDeps): RoutineOperations {
  /** Turns the routine off or back on, by the Routines page's rule. */
  const setEnabled = async (
    input: unknown,
    turn: RoutineTurn,
    enabled: boolean,
  ): Promise<RoutineControlResult> => {
    const refusal = changeRefusal(turn);
    if (refusal) return { status: "error", error: refusal };
    const routineId = text(fieldsOf(input).routineId);
    if (!routineId) return notFound(routineId);
    const result = await updateRoutine(
      { routines: deps.routines, engine: deps.engine },
      routineId,
      { enabled },
    );
    if (result.status === "not-found") return notFound(routineId);
    if (result.status === "refused") return { status: "error", error: result.error };
    const { routine } = result;
    return {
      status: "ok",
      data: { routineId: routine.id, name: routine.name, enabled: routine.enabled },
    };
  };

  return {
    pause: (input, turn) => setEnabled(input, turn, false),
    resume: (input, turn) => setEnabled(input, turn, true),

    // Runs its action for real, even when the routine is paused, and answers
    // once the run has started; the run records its own outcome.
    runNow: async (input, turn) => {
      const refusal = changeRefusal(turn);
      if (refusal) return { status: "error", error: refusal };
      const args = fieldsOf(input);
      const routineId = text(args.routineId);
      const row = routineId ? await deps.routines.findById(routineId) : null;
      if (!row) return notFound(routineId);
      const payload =
        args.input && typeof args.input === "object" && !Array.isArray(args.input)
          ? (args.input as Record<string, unknown>)
          : {};
      const runId = await startRoutineRun(deps.engine, routineId, payload);
      return { status: "ok", data: { routineId, name: row.name, runId, started: true } };
    },

    // Ends each running run as cancelled; a run awaiting approval is left.
    stop: async (input, turn) => {
      const refusal = changeRefusal(turn);
      if (refusal) return { status: "error", error: refusal };
      const routineId = text(fieldsOf(input).routineId);
      const row = routineId ? await deps.routines.findById(routineId) : null;
      if (!row) return notFound(routineId);
      const { stopped } = await deps.engine.cancelRun(routineId);
      return { status: "ok", data: { routineId, name: row.name, stopped } };
    },

    listRuns: async (input, turn) => {
      if (!(await turnWorksForGuardian(deps.ownerOfChat, turn))) return READ_REFUSED;
      const args = fieldsOf(input);
      const routineId = text(args.routineId);
      const row = routineId ? await deps.routines.findById(routineId) : null;
      if (!row) return notFound(routineId);
      const routine = toRoutine(row);
      const limit =
        typeof args.limit === "number" && Number.isInteger(args.limit)
          ? Math.min(Math.max(args.limit, 1), MAX_RUNS)
          : DEFAULT_RUNS;
      const runs = await listRoutineRuns(deps, routineId, { limit });
      return {
        status: "ok",
        data: {
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
        },
      };
    },

    readRun: async (input, turn) => {
      if (!(await turnWorksForGuardian(deps.ownerOfChat, turn))) return READ_REFUSED;
      const args = fieldsOf(input);
      const routineId = text(args.routineId);
      const runId = text(args.runId);
      const detail = routineId && runId ? await readRoutineRun(deps, routineId, runId) : null;
      if (!detail) {
        return {
          status: "error",
          error: `Routine "${routineId}" has no run "${runId}". List its runs with system:list_routine_runs.`,
        };
      }
      return { status: "ok", data: { ...detail, roots: detail.roots.map(forAgent) } };
    },
  };
}

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

function fieldsOf(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function notFound(routineId: string) {
  return {
    status: "error" as const,
    error: routineId
      ? `No routine found with id "${routineId}". Use system:search_routine to find the right id.`
      : "Pass the routine's id as routineId. Find it with system:search_routine.",
  };
}
