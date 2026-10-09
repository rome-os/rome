/**
 * An agent's id from its name, for `system:send_message` when it sends on
 * `agents` by name. It is handed to the system app alone, and reads Cloud's
 * listing of the agents this Rome can message: the guardian's own agents and
 * those of linked accounts.
 *
 * Names are labels two agents can share, so a name resolves only when one
 * agent has it. A whole label, such as `Atlas (@ouou's dot)`, is matched
 * before a bare name, which is how a caller picks between agents that share
 * one. Nothing is guessed between matches.
 */

import { agentLabel } from "../lib/rome-cloud-agents.js";
import type { ExternalAgents } from "./agents-accounts.js";

export type AgentNameResolution =
  | { status: "found"; agentId: string }
  | { status: "ambiguous"; matches: { label: string; agentId: string }[] }
  | { status: "none" }
  | { status: "not_connected" };

export interface AgentNamesService {
  resolve(name: string): Promise<AgentNameResolution>;
}

export function createAgentNames(agents: ExternalAgents): AgentNamesService {
  return {
    async resolve(name) {
      if (!agents.connected()) return { status: "not_connected" };
      const wanted = name.trim().toLowerCase();
      const listed = await agents.list();
      const labelled = listed.filter((agent) => agentLabel(agent).toLowerCase() === wanted);
      const matches =
        labelled.length > 0
          ? labelled
          : listed.filter((agent) => agent.name.trim().toLowerCase() === wanted);
      if (matches.length === 0) return { status: "none" };
      if (matches.length === 1) return { status: "found", agentId: matches[0].agentId };
      return {
        status: "ambiguous",
        matches: matches.map((agent) => ({ label: agentLabel(agent), agentId: agent.agentId })),
      };
    },
  };
}
