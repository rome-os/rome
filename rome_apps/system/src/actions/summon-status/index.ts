import type { Action, ActionConfig, ActionResult, ChildSessions } from "@rome-os/app-runtime";
import { defineAction, MAX_CHILD_TRANSCRIPT_TAIL, z } from "@rome-os/app-runtime";
import type { SummonStatusNotFound, SummonStatusOutput } from "./types.js";
export type { SummonStatusNotFound, SummonStatusOutput } from "./types.js";

/** The host clamps an over-large ask. Refusing it here instead tells the agent
 * its number was ignored, which a silent trim does not. */
const MAX_TRANSCRIPT_TAIL = MAX_CHILD_TRANSCRIPT_TAIL;

export const summonStatusInputSchema = z.object({
  sessionId: z
    .string()
    .describe("Child session id returned by a detached summon (`data.sessionId`)"),
  transcriptTail: z
    .number()
    .int()
    .min(0)
    .max(MAX_TRANSCRIPT_TAIL)
    .optional()
    .describe(
      `Include the child's last N messages, oldest-first (max ${MAX_TRANSCRIPT_TAIL}). ` +
        "Omit or pass 0 for status and final reply only.",
    ),
});

export type SummonStatusInput = z.infer<typeof summonStatusInputSchema>;

export interface SummonStatusDeps {
  childSessions: ChildSessions;
}

/**
 * Creates the summon_status action: the read half of a detached summon. It
 * answers from durable trace joined with the live turn registry, so it works
 * from a session that has nothing to do with the one that started the child.
 */
export function createSummonStatusAction(config: ActionConfig, deps: SummonStatusDeps): Action {
  return defineAction({
    config,
    schema: summonStatusInputSchema,
    execute: async ({ sessionId, transcriptTail }): Promise<ActionResult> => {
      const report = await deps.childSessions.getStatus({ sessionId, transcriptTail });
      if (!report) {
        const notFound: SummonStatusNotFound = { status: "not_found", sessionId };
        return { status: "ok", data: notFound };
      }
      return { status: "ok", data: report satisfies SummonStatusOutput };
    },
    preview: ({ sessionId }) => ({
      kind: "generic",
      title: "Check a summoned agent",
      summary: sessionId,
    }),
  });
}

export function createAction(config: ActionConfig, deps: SummonStatusDeps): Action {
  return createSummonStatusAction(config, deps);
}
