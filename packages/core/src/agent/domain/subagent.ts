// A subagent: an agent that another agent's turn hands work to
// (docs/domains/agents.md#subagent).

import { createHash } from "node:crypto";
import type { ModelToolCallContext } from "./rome-tools.js";

/** A subagent this agent may hand work to. */
export interface Subagent {
  /** The subagent's canonical agent id, e.g. `core:helper`. */
  name: string;
  description: string;
}

/** The subagents this agent may hand work to. */
export interface Subagents {
  list(): readonly Subagent[];
  /** Runs the subagent's session as a child of the calling turn. */
  run(name: string, input: unknown, call: ModelToolCallContext): Promise<unknown>;
}

/**
 * The model-facing tool name for delegating to a subagent. Provider tool names
 * reject the ":" in an agent id, so the id maps to a stable hash.
 */
export function subagentToolName(subagentName: string): string {
  return `sa_${createHash("sha256").update(subagentName).digest("hex").slice(0, 16)}`;
}
