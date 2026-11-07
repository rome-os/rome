// A subagent: an agent that another agent's turn hands work to
// (docs/domains/agents.md#subagent).

import type { ModelToolCallContext, RomeToolDefinition } from "./rome-tools.js";

/** The subagents this agent may hand work to, each served as a tool. */
export interface Subagents {
  tools: readonly RomeToolDefinition[];
  /** Runs the subagent's session as a child of the calling turn. */
  run(name: string, input: unknown, call: ModelToolCallContext): Promise<unknown>;
}
