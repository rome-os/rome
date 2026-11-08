// The run's way to forget a subagent call, until the run moves into the agent
// context and calls `SubagentCalls.forget` itself.

import type { SubagentCalls } from "../agent/index.js";

export interface ParentSubagentRef {
  sessionId: string;
  turnId: string;
  toolUseId: string;
}

export interface ActiveSubagentRegistry {
  clearByParent(parent: ParentSubagentRef): void;
}

export function createActiveSubagentRegistry(calls: SubagentCalls): ActiveSubagentRegistry {
  return {
    clearByParent(parent) {
      calls.forget({
        dashboardSessionId: parent.sessionId,
        turnId: parent.turnId,
        toolUseId: parent.toolUseId,
      });
    },
  };
}
