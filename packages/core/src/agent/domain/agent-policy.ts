import type { AgentName } from "./session.js";

/**
 * How a chat treats one agent's turns. The agent YAML declares it in an
 * optional `policy:` block; each omitted field keeps the default, which is
 * the behavior every chat had before the policy existed.
 */
export interface AgentPolicy {
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
  /**
   * Whether a session opened by continuity key is replaced by a fresh one in
   * the same chat when the agent's setup changed since it opened: its
   * instructions, its identity, or its tools. A session resumed by id is
   * never replaced. docs/concepts/sessions.md#setup
   */
  freshSessionOnSetupChange: boolean;
  /**
   * Whether the agent's `defer` waits for an event only with a label saying
   * what it waits for and a deadline when it wakes anyway, as the
   * Concierge's checks do. Off, an event wait takes neither.
   */
  eventWaitDeadline: boolean;
}

export function resolveAgentPolicy(agent: {
  name: AgentName;
  policy?: Partial<AgentPolicy>;
}): AgentPolicy {
  return {
    finalText: agent.policy?.finalText ?? "deliver",
    autoTitle: agent.policy?.autoTitle ?? true,
    loadMemory: agent.policy?.loadMemory ?? agent.name === "main",
    freshSessionOnSetupChange: agent.policy?.freshSessionOnSetupChange ?? false,
    eventWaitDeadline: agent.policy?.eventWaitDeadline ?? false,
  };
}
