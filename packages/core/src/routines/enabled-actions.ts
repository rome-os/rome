// The agent's way to turn a routine off and back on: `core:routine_pause` and
// `core:routine_resume`, over the same change as the Routines page (update.ts).

import type { ActionRegistry } from "../apps/actions/types.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type { RoutineEngine } from "./engine.js";
import { changeRefusal } from "./turn-access.js";
import { updateRoutine } from "./update.js";

export const ROUTINE_PAUSE_ACTION = "core:routine_pause";
export const ROUTINE_RESUME_ACTION = "core:routine_resume";

export interface RoutineEnabledActionDeps {
  routines: Pick<RoutinesRepository, "findById" | "update">;
  engine: Pick<RoutineEngine, "activate" | "deactivate">;
}

const INPUT_SCHEMA = {
  type: "object",
  required: ["routineId"],
  properties: {
    routineId: { type: "string", description: "The routine's id, from system:search_routine." },
  },
  additionalProperties: false,
} as const;

/** Registers pausing and resuming a routine. */
export function registerRoutineEnabledActions(
  actions: Pick<ActionRegistry, "register">,
  deps: RoutineEnabledActionDeps,
): void {
  for (const [name, enabled] of [
    [ROUTINE_PAUSE_ACTION, false],
    [ROUTINE_RESUME_ACTION, true],
  ] as const) {
    actions.register({
      config: {
        name,
        type: "system",
        description: enabled
          ? "Turn a paused routine back on, so it fires on its schedule or event again. Use it when the guardian asks to resume or restart a routine. A one-off whose time has passed cannot come back on. Only in the guardian's private chat, in a turn their own message started. Find the routine's id with system:search_routine."
          : "Pause a routine: it stays saved but stops firing until resumed. Use it when the guardian asks to stop, pause or turn off a routine for now, rather than delete it. Only in the guardian's private chat, in a turn their own message started. Find the routine's id with system:search_routine.",
        complexity: "simple",
        speed: "fast",
        reliability: "high",
        sideEffects: "write",
      },
      inputSchema: INPUT_SCHEMA,
      execute: async (args) => {
        const refusal = changeRefusal();
        if (refusal) return { status: "error", error: refusal };
        const routineId = typeof args.routineId === "string" ? args.routineId.trim() : "";
        const result = routineId
          ? await updateRoutine(deps, routineId, { enabled })
          : ({ status: "not-found" } as const);
        if (result.status === "not-found") {
          return {
            status: "error",
            error: `No routine found with id "${routineId}". Use system:search_routine to find the right id.`,
          };
        }
        if (result.status === "refused") return { status: "error", error: result.error };
        const { routine } = result;
        return {
          status: "ok",
          data: { routineId: routine.id, name: routine.name, enabled: routine.enabled },
        };
      },
    });
  }
}
