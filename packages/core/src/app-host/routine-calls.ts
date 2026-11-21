// What Routines offers apps. An app's action worker runs in its own process
// and reaches the routine engine, which lives in the main process, through
// these calls.

import { z } from "zod";
import type { IpcCallContext } from "../apps/actions/ipc.js";
import { toRoutine, type RoutinesRepository } from "../db/repositories/routines.js";
import { parseWorkerCallParams } from "../lib/worker-call-params.js";
import {
  ROUTINE_CONTROL_OPS,
  type RoutineOperations,
  type RoutineTurn,
} from "../routines/control.js";
import type { RoutineEngine } from "../routines/engine.js";
import type { RoutineCreationService } from "../routines/create.js";

/** A call an app's worker makes on the main process: it takes the call's params and returns its result. */
export type WorkerCallHandler = (params: unknown, context?: IpcCallContext) => Promise<unknown>;

const RoutineIdParams = z.object({ routineId: z.string().min(1) });
const CreateParams = z.object({
  input: z.unknown(),
  caller: z.object({ callerAppId: z.string().optional(), agentName: z.string().optional() }),
});
const ControlParams = z.object({ op: z.enum(ROUTINE_CONTROL_OPS), input: z.unknown() });

function routineIdOf(method: string, params: unknown): string {
  return parseWorkerCallParams(method, RoutineIdParams, params).routineId;
}

export interface RoutineWorkerCallsDeps {
  routinesRepo: Pick<RoutinesRepository, "findById">;
  routineEngine: Pick<RoutineEngine, "activate" | "deactivate">;
  routineCreation: RoutineCreationService;
  routineOperations: RoutineOperations;
}

/** The routine calls an app's worker makes, keyed by method name. */
export function routineWorkerCalls(
  deps: RoutineWorkerCallsDeps,
): Record<string, WorkerCallHandler> {
  return {
    // Brings the engine in line with the stored routine: armed when enabled,
    // disarmed otherwise.
    "routines.schedule": async (params) => {
      const routineId = routineIdOf("routines.schedule", params);
      const row = await deps.routinesRepo.findById(routineId);
      if (!row) throw new Error(`Routine not found: ${routineId}`);
      if (row.enabled ?? true) {
        await deps.routineEngine.activate(toRoutine(row));
      } else {
        await deps.routineEngine.deactivate(routineId);
      }
      return { ok: true };
    },
    // Creates a routine by core's rules, for the app or agent that asked in
    // the worker.
    "routines.create": async (params, context) => {
      const { input, caller } = parseWorkerCallParams("routines.create", CreateParams, params);
      // Who the worker's action acts for and the chat it runs in, as the IPC
      // boundary captured them.
      const from = context?.callerActionContext;
      const thread = from?.channelContext;
      const chatId = thread?.channel === "webchat" ? thread.threadId : undefined;
      return deps.routineCreation.create(input, {
        kind: "action",
        ...caller,
        ...(from ? { origin: { actor: from.actor ?? null, ...(chatId ? { chatId } : {}) } } : {}),
      });
    },
    "routines.cancel": async (params) => {
      const routineId = routineIdOf("routines.cancel", params);
      await deps.routineEngine.deactivate(routineId);
      return { ok: true };
    },
    // A system app routine action, for the turn of the worker's action as the
    // IPC boundary captured it. Without one, the turn shows no one and the
    // operation refuses.
    "routines.control": async (params, context) => {
      const { op, input } = parseWorkerCallParams("routines.control", ControlParams, params);
      return deps.routineOperations[op](input, turnOf(context));
    },
  };
}

function turnOf(context: IpcCallContext | undefined): RoutineTurn {
  const from = context?.callerActionContext;
  return {
    ...(from?.actor ? { actor: from.actor } : {}),
    ...(from?.audience ? { audience: from.audience } : {}),
    ...(from?.channelContext ? { channelContext: from.channelContext } : {}),
  };
}
