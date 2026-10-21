import {
  LINKABLE_SERVICES,
  MAIN_AGENT_ID,
  agentLabel,
  canonicalAgent,
} from "@rome/api-types/account-agents";
import { platformOf } from "@rome/api-types/platform";
import type { ApiConnection } from "@/lib/connections-api";
import { connectionRoute, serviceLabel } from "@/lib/connection-cards";

// Envoys reads the same feed as Connections and regroups it by agent. An
// account is one connected account of a linkable service; it has at most one
// agent. Vocabulary: docs/domains/chats.md#account.

/** How an agent is linked to an account: the account is the agent's own, or it
 *  is the guardian's and the agent answers on their behalf as a delegate. */
export type LinkKind = "own" | "delegate";

/** The guardian's own signed-in accounts. An agent linked to one is a delegate. */
const DELEGATE_SERVICES: ReadonlySet<string> = new Set(["telegram_user"]);

export interface EnvoyAccount {
  /** The account's channel id, which the link route addresses. */
  channel: string;
  /** The connection and grant that disconnecting the account revokes. */
  connectionId: string;
  grant: string;
  service: string;
  platform: string;
  /** The name people see on the platform, else the platform's name. */
  name: string;
  kind: LinkKind;
  /** Canonical id of the account's agent, or null when it has none. */
  agent: string | null;
  /** Where the account's Connections card opens, or null when no card shows
   *  or sets this account's agent. A delegate's account is folded into its
   *  brand's card as a slot, and that card shows only the bot's agent. */
  route: string | null;
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

function accountName(connection: ApiConnection): string | null {
  for (const display of Object.values(connection.display)) {
    const name = display?.displayName || display?.handle || display?.email;
    if (name) return name;
  }
  return null;
}

/** The grant through which an account is connected, if any. */
function connectedGrant(connection: ApiConnection): string | null {
  const grant = Object.entries(connection.grants).find(([, state]) => state !== "unauthorized");
  return grant ? grant[0] : null;
}

function toAccount(connection: ApiConnection): EnvoyAccount | null {
  if (!LINKABLE_SERVICES.has(connection.service)) return null;
  // A core that predates agent links omits `agent`, and a placeholder has no
  // channel, so neither is an account that can carry an agent.
  if (connection.id === null || !connection.channel || connection.agent === undefined) return null;
  const grant = connectedGrant(connection);
  if (!grant) return null;
  // A core that predates `platform` omits it, and the service alone cannot
  // tell a Lark app from a Feishu one, so such an app reads as Feishu.
  const platform = connection.platform ?? platformOf(connection.service);
  const kind = DELEGATE_SERVICES.has(connection.service) ? "delegate" : "own";
  return {
    channel: connection.channel,
    connectionId: connection.id,
    grant,
    service: connection.service,
    platform,
    name: accountName(connection) ?? serviceLabel(platform),
    kind,
    agent: connection.agent === null ? null : canonicalAgent(connection.agent),
    route: kind === "delegate" ? null : connectionRoute(connection),
  };
}

function compareAgents(a: string, b: string): number {
  if ((a === MAIN_AGENT_ID) !== (b === MAIN_AGENT_ID)) return a === MAIN_AGENT_ID ? -1 : 1;
  return agentLabel(a).localeCompare(agentLabel(b));
}

/** The query key of the connections Envoys reads. */
export const CONNECTIONS_KEY = ["envoys", "connections"] as const;

/** Groups the connected accounts by the agent speaking through them. Agents
 *  sort by name with main first, and accounts with no agent are listed apart.
 *  `agents` is every agent an account can be linked to, in the same order.
 *  Pass null for `loaded` while the agent list is missing. */
export function buildEnvoys(
  connections: readonly ApiConnection[],
  loaded: readonly AgentListing[] | null,
): { envoys: Envoy[]; unlinked: EnvoyAccount[]; agents: string[] } {
  const descriptions = new Map(
    (loaded ?? []).map((agent) => [canonicalAgent(agent.name), agent.description ?? null]),
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
  const envoys = [...byAgent.values()].sort((a, b) => compareAgents(a.agent, b.agent));
  // Core links only loaded agents, and main always. Without the list, the
  // linked agents are the best guess. An account keeps its own unloaded agent
  // in its select (`AgentChange`).
  const names = new Set([MAIN_AGENT_ID, ...(loaded ? descriptions.keys() : byAgent.keys())]);
  return { envoys, unlinked, agents: [...names].sort(compareAgents) };
}

/** Services an agent's own account is made on, in the order Envoys offers them. */
const OWN_SERVICES = ["feishu", "telegram", "discord", "slack_bot"] as const;

/** One platform a new account can be connected on, and how its setup starts. */
export interface ConnectChoice {
  service: string;
  platform: string;
  kind: LinkKind;
  /** Whether the setup mints a new account rather than filling the service's
   *  one. Envoys cancels its setup when the page that runs it closes. An
   *  account can still connect with no agent, when the link after it fails,
   *  and waits under Connected, no agent. */
  another: boolean;
  /** A setup already under way for the service's one account, to re-attach to. */
  activeSetupCid: string | null;
  /** The service holds one account and it is connected, so none can be added. */
  taken: boolean;
}

/** The platforms a new account can be connected on, own accounts first. Each
 *  setup addresses the service, never a row, since a row left by a failed
 *  removal is gone once a setup starts. Where the service offers several
 *  accounts, even the first connects as a new account. Services core does not
 *  register are left out. */
export function connectChoices(connections: readonly ApiConnection[]): ConnectChoice[] {
  const choices: ConnectChoice[] = [];
  for (const service of [...OWN_SERVICES, ...DELEGATE_SERVICES]) {
    const rows = connections.filter((connection) => connection.service === service);
    if (rows.length === 0) continue;
    const anyConnected = rows.some((connection) => connectedGrant(connection) !== null);
    const several = rows.some((connection) => connection.severalAccounts === true);
    const live = rows.flatMap((connection) => Object.values(connection.setups))[0] ?? null;
    choices.push({
      service,
      platform: platformOf(service),
      kind: DELEGATE_SERVICES.has(service) ? "delegate" : "own",
      another: several,
      activeSetupCid: several ? null : live,
      taken: anyConnected && !several,
    });
  }
  return choices;
}
