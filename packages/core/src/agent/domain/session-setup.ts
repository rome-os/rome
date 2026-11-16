// A session's setup: what it takes when it opens and keeps for its life.
// Vocabulary: docs/concepts/sessions.md#setup.

import { createHash } from "node:crypto";
import { ROME_TOOL_GROUPS, type RomeToolDefinition, type RomeToolGroup } from "./rome-tools.js";

/** Value object. What a session opens with that a later change cannot reach. */
export interface SessionSetup {
  /** The system prompt without memory, identity or the opener's context
   *  suffix: the agent's instructions and the charter. */
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

/** What tells a fingerprint of two parts from one recorded before setups had parts. */
const PREFIX = "v2";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * A fingerprint of a setup, in two parts: one for its text (the instructions
 * and the charter) and one for its tools (Rome's tools, the provider's tools,
 * the MCP servers and the answer's shape). Each part is equal for two setups
 * the model would read the same way.
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
  const text = hash([setup.systemPrompt]);
  const toolsPart = hash([
    [...setup.builtinTools],
    [...setup.mcpServers],
    setup.outputSchema,
    tools,
  ]);
  return `${PREFIX}:${text}:${toolsPart}`;
}

/**
 * What changed between the setup a session recorded and the current one:
 * nothing, only its text, its tools (whether or not its text changed too),
 * or `unknown` for a session that recorded no setup or one fingerprinted
 * before setups had two parts, so nothing says which part changed.
 */
export type SetupChange = "none" | "text" | "tools" | "unknown";

export function setupChange(recorded: string | null, current: string): SetupChange {
  if (recorded === current) return "none";
  const before = parts(recorded);
  const now = parts(current);
  if (!before || !now) return "unknown";
  if (before.tools !== now.tools) return "tools";
  return before.text !== now.text ? "text" : "none";
}

function parts(fingerprint: string | null): { text: string; tools: string } | null {
  const [prefix, text, tools, ...rest] = fingerprint?.split(":") ?? [];
  return prefix === PREFIX && text && tools && rest.length === 0 ? { text, tools } : null;
}
