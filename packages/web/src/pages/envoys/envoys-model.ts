import { LINKABLE_SERVICES, MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import { platformOf } from "@rome/api-types/platform";
import type { ApiConnection } from "@/lib/connections-api";
import { connectionRoute, serviceLabel } from "@/lib/connection-cards";

// Envoys reads the same feed as Connections and regroups it by agent. An
// account is one connected account of a linkable service; it has at most one
// agent. Vocabulary: docs/concepts/messaging.md#romes-accounts.

/** How an agent is linked to an account: the account is the agent's own, or it
 *  is the guardian's and the agent answers on their behalf as a delegate. */
export type LinkKind = "own" | "delegate";

/** The guardian's own signed-in accounts. An agent linked to one is a delegate. */
const DELEGATE_SERVICES: ReadonlySet<string> = new Set(["telegram_user"]);

/** A personal account opens on its brand's Connections card, where it is folded
 *  in as a slot (`buildConnectionCards`). */
const CARD_ROUTE_BY_SERVICE: Readonly<Record<string, string>> = {
  telegram_user: "telegram",
};

export interface EnvoyAccount {
  /** The account's channel id, which the link route addresses. */
  channel: string;
  service: string;
  platform: string;
  /** The name people see on the platform, else the platform's name. */
  name: string;
  kind: LinkKind;
  /** Canonical id of the account's agent, or null when it has none. */
  agent: string | null;
  /** Where the account's Connections card opens. */
  route: string;
}

export interface Envoy {
  /** Canonical agent id, as an account stores it. */
  agent: string;
  description: string | null;
  accounts: EnvoyAccount[];
}

export interface AgentListing {
  name: string;
  description?: string | null;
}

/** `/api/agents` and the link route also know main as `main`. */
export function canonicalAgent(name: string): string {
  return name === "main" ? MAIN_AGENT_ID : name;
}

/** The name an agent is shown under. */
export function agentLabel(agent: string): string {
  return agent === MAIN_AGENT_ID ? "main" : agent;
}

function accountName(connection: ApiConnection): string | null {
  for (const display of Object.values(connection.display)) {
    const name = display?.displayName || display?.handle || display?.email;
    if (name) return name;
  }
  return null;
}

function toAccount(connection: ApiConnection): EnvoyAccount | null {
  if (!LINKABLE_SERVICES.has(connection.service)) return null;
  // A core that predates agent links omits `agent`, and a placeholder has no
  // channel, so neither is an account that can carry an agent.
  if (connection.id === null || !connection.channel || connection.agent === undefined) return null;
  const connected = Object.values(connection.grants).some((state) => state !== "unauthorized");
  if (!connected) return null;
  const platform = platformOf(connection.service);
  return {
    channel: connection.channel,
    service: connection.service,
    platform,
    name: accountName(connection) ?? serviceLabel(platform),
    kind: DELEGATE_SERVICES.has(connection.service) ? "delegate" : "own",
    agent: connection.agent === null ? null : canonicalAgent(connection.agent),
    route: CARD_ROUTE_BY_SERVICE[connection.service] ?? connectionRoute(connection),
  };
}

/** Groups the connected accounts by the agent speaking through them. Agents
 *  sort by name with main first, and accounts with no agent are listed apart. */
export function buildEnvoys(
  connections: readonly ApiConnection[],
  agents: readonly AgentListing[],
): { envoys: Envoy[]; unlinked: EnvoyAccount[] } {
  const descriptions = new Map(
    agents.map((agent) => [canonicalAgent(agent.name), agent.description ?? null]),
  );
  const byAgent = new Map<string, Envoy>();
  const unlinked: EnvoyAccount[] = [];
  for (const connection of connections) {
    const account = toAccount(connection);
    if (!account) continue;
    if (account.agent === null) {
      unlinked.push(account);
      continue;
    }
    let envoy = byAgent.get(account.agent);
    if (!envoy) {
      envoy = {
        agent: account.agent,
        description: descriptions.get(account.agent) ?? null,
        accounts: [],
      };
      byAgent.set(account.agent, envoy);
    }
    envoy.accounts.push(account);
  }
  const envoys = [...byAgent.values()].sort((a, b) => {
    if ((a.agent === MAIN_AGENT_ID) !== (b.agent === MAIN_AGENT_ID)) {
      return a.agent === MAIN_AGENT_ID ? -1 : 1;
    }
    return agentLabel(a.agent).localeCompare(agentLabel(b.agent));
  });
  return { envoys, unlinked };
}
