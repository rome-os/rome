import type { Action, ActionConfig, ActionResult, ChildSessions } from "@rome-os/app-runtime";
import { defineAction, z } from "@rome-os/app-runtime";
import type { SummonStopNotFound, SummonStopOutput } from "./types.js";
export type { SummonStopNotFound, SummonStopOutput } from "./types.js";

export const summonStopInputSchema = z.object({
  sessionId: z
    .string()
    .describe("Child session id returned by a detached summon (`data.sessionId`)"),
});

export type SummonStopInput = z.infer<typeof summonStopInputSchema>;

export interface SummonStopDeps {
  childSessions: ChildSessions;
}

/**
 * Creates the summon_stop action: the escape hatch of a detached summon. A
 * child that is wedged or no longer wanted is asked to stop, and the caller
 * learns whether there was a running turn to stop at all. Idempotent — stopping
 * a child that already ended reports its status and changes nothing.
 */
export function createSummonStopAction(config: ActionConfig, deps: SummonStopDeps): Action {
  return defineAction({
    config,
    schema: summonStopInputSchema,
    execute: async ({ sessionId }): Promise<ActionResult> => {
      const result = await deps.childSessions.stop({ sessionId });
      if (!result) {
        const notFound: SummonStopNotFound = { status: "not_found", sessionId };
        return { status: "ok", data: notFound };
      }
      return { status: "ok", data: { ...result, sessionId } satisfies SummonStopOutput };
    },
    preview: ({ sessionId }) => ({
      kind: "generic",
      title: "Stop a summoned agent",
      summary: sessionId,
    }),
  });
}

export function createAction(config: ActionConfig, deps: SummonStopDeps): Action {
  return createSummonStopAction(config, deps);
}
