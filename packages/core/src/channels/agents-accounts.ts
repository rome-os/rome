/**
 * The Agents channel's address book: the other endpoints in this Rome's Cloud
 * account, such as the guardian's dots, and the endpoints of accounts linked
 * to it. Read live from Rome Cloud, so a dot is on the People page, and can be
 * linked at a bond level, before it ever messages Rome. Contract: `Accounts`
 * (accounts.ts).
 *
 * An account is an endpoint, and its id is Cloud's `endpointId`, which never
 * changes. Its name is a label its owner can change and another endpoint can
 * share, so a rename keeps the endpoint's link and a reused name starts with
 * none.
 *
 * Any endpoint id resolves, listed or not: an agent Rome wrote to can answer
 * without a link, and such a sender still has to be an account the guardian
 * can find and place (I4).
 */

import { compareCodePoints } from "@rome/api-types/people";
import {
  type AgentEndpointSummary,
  type AgentMessagingClient,
  agentLabel,
} from "../lib/rome-cloud-agents.js";
import { createLogger } from "../logger.js";
import type { Account, AccountId, Accounts } from "./accounts.js";
import { pageAccounts } from "./account-paging.js";

const log = createLogger("agents-accounts");

/** How long one read of Cloud's endpoint list answers. A People page reads the
 *  whole listing and resolves every stored address at once, so this keeps that
 *  to one request. */
const READ_TTL_MS = 30_000;

/** Cloud's endpoint ids are UUIDs. */
const ENDPOINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An agent's account, named when Cloud has listed it. Names are labels two
 *  endpoints can share, so each carries its kind and, for another account's
 *  agent, that account's handle, as its messages do. */
function agentAccount(endpointId: string, endpoint?: AgentEndpointSummary): Account {
  return {
    id: endpointId as AccountId,
    addresses: [endpointId],
    name: endpoint ? agentLabel(endpoint) : null,
    identifiers: endpoint
      ? { "agents:kind": endpoint.kind, "agents:account": endpoint.account }
      : {},
  };
}

export function agentsAccounts(deps: {
  client: Pick<AgentMessagingClient, "endpoints">;
  /** Whether the guardian has connected Agents. Until then the channel
   *  reaches no one, and Cloud is not asked. */
  isConnected: () => boolean;
  now?: () => number;
}): Accounts {
  const now = deps.now ?? Date.now;
  let read: { at: number; accounts: Promise<Account[]> } | null = null;

  function endpoints(): Promise<Account[]> {
    if (!deps.isConnected()) return Promise.resolve([]);
    if (read && now() - read.at < READ_TTL_MS) return read.accounts;
    const accounts = deps.client.endpoints().then(
      ({ self, endpoints }) =>
        endpoints
          // A dot still waiting on its pairing confirmation cannot be reached.
          .filter((endpoint) => endpoint.ready && endpoint.endpointId !== self.endpointId)
          .map((endpoint) => agentAccount(endpoint.endpointId, endpoint))
          .sort((a, b) => compareCodePoints(a.name ?? a.id, b.name ?? b.id)),
      // Every address book is read for every People page, so an unreachable
      // Cloud lists no agents rather than failing the page. The empty answer
      // is kept like any other read, so an outage does not hold each page
      // load for Cloud's timeout.
      (err: unknown) => {
        log.warn("Could not list agent endpoints", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      },
    );
    read = { at: now(), accounts };
    return accounts;
  }

  return {
    async listAccounts(input) {
      return pageAccounts(await endpoints(), input);
    },
    async resolve(address) {
      if (!ENDPOINT_ID.test(address)) return null;
      const listed = (await endpoints()).find((account) => account.id === address);
      return listed ?? agentAccount(address);
    },
  };
}
