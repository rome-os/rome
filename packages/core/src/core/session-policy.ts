import type { AgentConfig } from "../types.js";

/**
 * How a chat treats one agent's turns. The agent YAML declares it in an
 * optional `policy:` block; each omitted field keeps the default, which is
 * the behavior every chat had before the policy existed.
 */
export interface SessionPolicy {
  /**
   * `deliver` sends the model's text to the chat: in-turn narration as it
   * completes, then the final reply. `private` keeps all of it in the trace,
   * so the agent reaches the guardian only through its tools.
   */
  finalText: "deliver" | "private";
  /** Whether the chat's first message names the chat. */
  autoTitle: boolean;
  /** Whether the system prompt carries the memory index, project summaries, and runtime paths. */
  loadMemory: boolean;
}

export function resolveSessionPolicy(agent: Pick<AgentConfig, "name" | "policy">): SessionPolicy {
  return {
    finalText: agent.policy?.finalText ?? "deliver",
    autoTitle: agent.policy?.autoTitle ?? true,
    loadMemory: agent.policy?.loadMemory ?? agent.name === "main",
  };
}
