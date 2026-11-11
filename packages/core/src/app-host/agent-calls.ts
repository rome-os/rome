// What Agents offers apps. An app's action worker runs in its own process, and
// the agent catalog lives in the main process, so the worker asks here.

import { z } from "zod";
import { parseWorkerCallParams } from "../lib/worker-call-params.js";

const HasAgentParams = z.object({ name: z.string().min(1) });
const HasActionParams = z.object({
  agentName: z.string().min(1),
  actionName: z.string().min(1),
});

export interface AgentWorkerCallsDeps {
  /** Whether the catalog holds an agent of this name. */
  hasAgent: (name: string) => boolean;
  /** Whether the named agent's allow-list lets it call the action; false for an unknown agent. */
  hasAction: (agentName: string, actionName: string) => boolean;
}

/** The agent calls an app's worker makes, keyed by method name. */
export function agentWorkerCalls(
  deps: AgentWorkerCallsDeps,
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    // Lets the inbox's trusted path tell whether a connected account's bound
    // agent still exists or was uninstalled.
    "agent.hasAgent": async (params) => {
      const { name } = parseWorkerCallParams("agent.hasAgent", HasAgentParams, params);
      return { hasAgent: deps.hasAgent(name) };
    },
    // Lets the inbox's trusted path tell whether a bound agent can call an action.
    "agent.hasAction": async (params) => {
      const { agentName, actionName } = parseWorkerCallParams(
        "agent.hasAction",
        HasActionParams,
        params,
      );
      return { hasAction: deps.hasAction(agentName, actionName) };
    },
  };
}
