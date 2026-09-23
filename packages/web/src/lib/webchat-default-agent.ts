import type { AgentCatalogGroup, AgentMention } from "@/lib/chat-types";

export const WEBCHAT_DEFAULT_AGENT_SETTING_KEY = "webchatDefaultAgent";

export function isRomeMainAgent(agentName: string): boolean {
  return agentName === "main" || agentName === "core:main";
}

/**
 * Resolve a persisted runtime artifact id against the live Webchat catalog.
 * Labels and icons deliberately come from the catalog rather than the setting,
 * so app presentation changes do not make the stored identity stale.
 */
export function resolveDefaultAgentMention(
  groups: AgentCatalogGroup[],
  agentName: unknown,
): AgentMention | null {
  if (typeof agentName !== "string" || isRomeMainAgent(agentName)) return null;

  for (const group of groups) {
    const agent = group.agents.find((candidate) => candidate.name === agentName);
    if (!agent) continue;
    return {
      appId: group.ownerId,
      appLabel: group.label,
      agentName: agent.name,
      iconUrl: group.iconUrl,
    };
  }
  return null;
}

export function findMainAgentName(groups: AgentCatalogGroup[]): string | null {
  for (const group of groups) {
    const main = group.agents.find((agent) => isRomeMainAgent(agent.name));
    if (main) return main.name;
  }
  return null;
}
