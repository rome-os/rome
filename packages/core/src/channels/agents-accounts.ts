/**
 * The Agents channel's address book: the other agents in this Rome's Cloud
 * account, such as the guardian's dots, and the agents of accounts linked
 * to it. Read live from Rome Cloud, so a dot is on the People page, and can be
 * linked at a bond level, before it ever messages Rome. Contract: `Accounts`
 * (accounts.ts).
 *
 * An account is an agent, and its id is Cloud's `agentId`, which never
 * changes. Its name is a label its owner can change and another agent can
 * share, so a rename keeps the agent's link and a reused name starts with
 * none.
 *
 * Any agent id resolves, listed or not: an agent Rome wrote to can answer
 * without a link, and such a sender still has to be an account the guardian
 * can find and place (I4).
 */

import { compareCodePoints } from "@rome/api-types/people";
import {
  type ExternalAgent,
  type AgentMessagingClient,
  agentLabel,
  isAgentId,
} from "../lib/rome-cloud-agents.js";
import { createLogger } from "../logger.js";
import type { Account, AccountId, Accounts } from "./accounts.js";
import { pageAccounts } from "./account-paging.js";

const log = createLogger("agents-accounts");

/** How long one read of Cloud's agent list answers. A People page reads the
 *  whole listing and resolves every stored address at once, so this keeps that
 *  to one request. */
const READ_TTL_MS = 30_000;

/** An agent's account, named when Cloud has listed it. Names are labels two
 *  agents can share, so each carries its kind and, for another account's
 *  agent, that account's handle, as its messages do. */
function agentAccount(agentId: string, agent?: ExternalAgent): Account {
  return {
    id: agentId as AccountId,
    addresses: [agentId],
    name: agent ? agentLabel(agent) : null,
    // The id is searchable, since it is the one address a send accepts.
    identifiers: agent
      ? { "agents:id": agentId, "agents:kind": agent.kind, "agents:account": agent.account }
      : { "agents:id": agentId },
  };
}

/** The agents this Rome can message, read from Cloud. The People page and
 *  `send_message` by name share one read, so both see the same listing. */
export interface ExternalAgents {
  /** Whether the guardian has connected Agents. Until then the channel
   *  reaches no one, and Cloud is not asked. */
  connected(): boolean;
  /** Every agent but this Rome, or none while not connected. Rejects when
   *  Cloud cannot be read. */
  list(): Promise<ExternalAgent[]>;
}

export function externalAgents(deps: {
  client: Pick<AgentMessagingClient, "agents">;
  isConnected: () => boolean;
  now?: () => number;
}): ExternalAgents {
  const now = deps.now ?? Date.now;
  let read: { at: number; agents: Promise<ExternalAgent[]> } | null = null;

  return {
    connected: deps.isConnected,
    list() {
      if (!deps.isConnected()) return Promise.resolve([]);
      if (read && now() - read.at < READ_TTL_MS) return read.agents;
      // A failed read is kept like any other, so an outage does not hold
      // each People page load, or each send, for Cloud's timeout.
      const agents = deps.client
        .agents()
        .then(({ self, agents }) => agents.filter((agent) => agent.agentId !== self.agentId));
      agents.catch((err: unknown) => {
        log.warn("Could not list external agents", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      read = { at: now(), agents };
      return agents;
    },
  };
}

export function agentsAccounts(external: ExternalAgents): Accounts {
  function agents(): Promise<Account[]> {
    return (
      external
        .list()
        .then((agents) =>
          agents
            .map((agent) => agentAccount(agent.agentId, agent))
            // Names can repeat, so the id keeps the order, and each page, stable.
            .sort(
              (a, b) =>
                compareCodePoints(a.name ?? a.id, b.name ?? b.id) || compareCodePoints(a.id, b.id),
            ),
        )
        // Every address book is read for every People page, so an unreachable
        // Cloud, or a listing this Rome cannot read, lists no agents rather
        // than failing the page.
        .catch(() => [])
    );
  }

  return {
    async listAccounts(input) {
      return pageAccounts(await agents(), input);
    },
    async resolve(address) {
      if (!isAgentId(address)) return null;
      const listed = (await agents()).find((account) => account.id === address);
      return listed ?? agentAccount(address);
    },
  };
}
