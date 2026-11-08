// The tools a session carries beyond the ones every session of its agent has.
// Vocabulary: docs/domains/agents.md#session-tools.

import type { RomeTool, RomeToolDefinition } from "./rome-tools.js";

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
