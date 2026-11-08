// The tools a session carries beyond the ones every session of its agent has.
// Vocabulary: docs/domains/agents.md#session-tools.

import type { RomeTool, RomeToolDefinition } from "./rome-tools.js";
import type { TurnFacts } from "./turn-facts.js";

/** Port. Where a session's tools come from: `propose_routine` and the tools Rome adds for an agent. */
export interface SessionTools {
  /**
   * The session tools for the turns of `turn`. Asked each time the session
   * opens its model session, so an answer that depends on settings follows
   * them on the next open, and once for each fork. Turns with no speaker get
   * only the tools that refuse without one.
   */
  forTurn(turn: TurnFacts, hasSpeaker: boolean): Promise<RomeTool[]>;
}

/**
 * A fork's session tools are its source's, in the source's order and as the
 * model saw them there. Each runs through the fork's own tool of the same
 * name, and one the fork has none for is refused as unavailable in a forked
 * turn. A tool of the fork's own that the source did not have is not served.
 */
export function forkSessionTools(
  source: readonly RomeToolDefinition[],
  forkOwn: readonly RomeTool[],
): RomeTool[] {
  const own = new Map(forkOwn.map((tool) => [tool.name, tool]));
  return source.map((definition) => ({
    ...definition,
    handler:
      own.get(definition.name)?.handler ??
      (async () => ({
        content: [{ type: "text", text: `${definition.name} is unavailable in a forked turn.` }],
        isError: true,
      })),
  }));
}
