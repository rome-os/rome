// The agent's way to check what a routine did: `core:routine_runs_list` and
// `core:routine_run_read`, over the same reads as the Routines page (runs.ts).

import { actionExecutionContext } from "../apps/actions/context.js";
import type { ActionRegistry } from "../apps/actions/types.js";
import type { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { type RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import { type ActionTraceNode, listRoutineRuns, readRoutineRun } from "./runs.js";

export const ROUTINE_RUNS_LIST_ACTION = "core:routine_runs_list";
export const ROUTINE_RUN_READ_ACTION = "core:routine_run_read";

const DEFAULT_RUNS = 10;
const MAX_RUNS = 50;

export interface RoutineRunActionDeps {
  routines: Pick<RoutinesRepository, "findById">;
  routineRuns: Pick<RoutineRunsRepository, "findByRoutineId" | "findById">;
  actionExecutions: Pick<ActionExecutionsRepository, "findByRootExecutionIds">;
  /** Whose chat it is ("guardian" or "visitor:<account>"), or null for a chat
   * that no longer exists. */
  ownerOfChat(chatId: string): Promise<string | null>;
}

const iso = (d: Date | undefined | null): string | null => (d ? d.toISOString() : null);

/** Registers the two reads of a routine's runs. */
export function registerRoutineRunActions(
  actions: Pick<ActionRegistry, "register">,
  deps: RoutineRunActionDeps,
): void {
  const refusal = {
    status: "error" as const,
    error: "Only the guardian's agents can read routines.",
  };

  actions.register({
    config: {
      name: ROUTINE_RUNS_LIST_ACTION,
      type: "system",
      description:
        "Check what a routine did: whether it is on, when it last ran and runs next, and its recent runs newest first, each with its status (success, error, running, pending_approval or cancelled), time and error. Use it when the guardian asks whether a routine ran, failed or is due. Find the routine's id with system:search_routine.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: {
      type: "object",
      required: ["routineId"],
      properties: {
        routineId: { type: "string", description: "The routine's id, from system:search_routine." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RUNS,
          description: `How many recent runs to return. Default ${DEFAULT_RUNS}.`,
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      if (!(await askedForGuardian(deps))) return refusal;
      const routineId = typeof args.routineId === "string" ? args.routineId.trim() : "";
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
  });

  actions.register({
    config: {
      name: ROUTINE_RUN_READ_ACTION,
      type: "system",
      description:
        "Read one run of a routine in full: its status, its error, and every action it ran as a tree, with each action's arguments, status, error and duration. Use it to explain why a run failed or what it did. Get the run's id from core:routine_runs_list.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: {
      type: "object",
      required: ["routineId", "runId"],
      properties: {
        routineId: { type: "string", description: "The routine's id." },
        runId: { type: "string", description: "The run's id, from core:routine_runs_list." },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      if (!(await askedForGuardian(deps))) return refusal;
      const routineId = typeof args.routineId === "string" ? args.routineId.trim() : "";
      const runId = typeof args.runId === "string" ? args.runId.trim() : "";
      const detail = routineId && runId ? await readRoutineRun(deps, routineId, runId) : null;
      if (!detail) {
        return {
          status: "error",
          error: `Routine "${routineId}" has no run "${runId}". List its runs with ${ROUTINE_RUNS_LIST_ACTION}.`,
        };
      }
      return { status: "ok", data: { ...detail, roots: detail.roots.map(forAgent) } };
    },
  });
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

function notFound(routineId: string) {
  return {
    status: "error" as const,
    error: routineId
      ? `No routine found with id "${routineId}". Use system:search_routine to find the right id.`
      : "Pass the routine's id as routineId. Find it with system:search_routine.",
  };
}

/** Whether the running turn works for the guardian, who alone reads routines
 * on the dashboard. A visitor's turn, or a turn no one started in a visitor's
 * chat, is refused. A turn with neither an actor nor a chat cannot show it is
 * the guardian's and is refused too. A chat on a connection has no owner and
 * is the guardian's agent's. The same rule as `core:read_person`. */
async function askedForGuardian(deps: Pick<RoutineRunActionDeps, "ownerOfChat">): Promise<boolean> {
  const context = actionExecutionContext.getStore();
  if (context?.actor && context.actor.kind !== "guardian") return false;
  const thread = context?.channelContext;
  if (!context?.actor && !thread) return false;
  if (thread?.channel === "webchat") {
    const owner = thread.threadId ? await deps.ownerOfChat(thread.threadId) : null;
    if (owner !== "guardian") return false;
  }
  return true;
}
