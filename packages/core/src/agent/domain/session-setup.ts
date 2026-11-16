// A session's setup: what it takes when it opens and keeps for its life.
// Vocabulary: docs/concepts/sessions.md#setup.

import { createHash } from "node:crypto";
import { ROME_TOOL_GROUPS, type RomeToolDefinition, type RomeToolGroup } from "./rome-tools.js";

/** Value object. What a session opens with that a later change cannot reach. */
export interface SessionSetup {
  /** The system prompt without memory or the opener's context suffix: the
   *  agent's instructions and identity. */
  systemPrompt: string;
  /** The provider's own tools the agent declares. */
  builtinTools: readonly string[];
  /** The MCP servers the agent declares, each with its whole config, by name. */
  mcpServers: readonly { name: string; command: string; args: readonly string[] }[];
  /** The schema the agent's final answer follows, or null. */
  outputSchema: unknown;
  /** Rome's tools by group, as the model reads their names and schemas. */
  tools: Readonly<Record<RomeToolGroup, readonly RomeToolDefinition[]>>;
}

/**
 * A fingerprint of a setup: equal for two setups the model would read the
 * same way, different when the instructions, the identity or a tool changed.
 */
export function setupFingerprint(setup: SessionSetup): string {
  const tools = ROME_TOOL_GROUPS.map((group) => [
    group,
    setup.tools[group].map(({ name, description, inputSchema }) => [
      name,
      description,
      inputSchema,
    ]),
  ]);
  const canonical = JSON.stringify([
    setup.systemPrompt,
    [...setup.builtinTools],
    [...setup.mcpServers],
    setup.outputSchema,
    tools,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Whether a session that opened with `recorded` is due to be replaced by one
 * that opens with `current`. A session that recorded none opened before
 * setups were recorded, so nothing says it holds the current one.
 */
export function setupChanged(recorded: string | null, current: string): boolean {
  return recorded !== current;
}
