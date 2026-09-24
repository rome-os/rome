import type { AgentCatalogGroup } from "./chat-types";

function tokensMatch(haystack: string, query: string): boolean {
  if (!query) return true;
  return haystack.toLowerCase().includes(query.toLowerCase());
}

/**
 * Narrows the `GET /api/chat/agents` catalog to what an `@<query>` mention can
 * reach. An app stays when its id or label matches, or when any of its agents
 * match. A matching app keeps all of its agents; otherwise only the matching
 * agents remain. So `@expl` narrows the list to apps that own an
 * `explore`-like agent. Groups with no agent left are dropped, and server
 * order is kept.
 */
export function filterAgentCatalog(
  groups: AgentCatalogGroup[],
  query: string,
): AgentCatalogGroup[] {
  const out: AgentCatalogGroup[] = [];
  for (const group of groups) {
    const appMatches =
      !query || tokensMatch(group.ownerId, query) || tokensMatch(group.label, query);
    const agents = appMatches
      ? group.agents
      : group.agents.filter(
          (agent) =>
            tokensMatch(agent.localName ?? agent.name, query) ||
            tokensMatch(agent.name, query) ||
            tokensMatch(`${group.ownerId}/${agent.localName ?? agent.name}`, query),
        );
    if (agents.length === 0) continue;
    out.push({ ...group, agents });
  }
  return out;
}
