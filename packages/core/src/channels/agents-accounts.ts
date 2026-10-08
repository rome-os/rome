/**
 * The Agents channel's address book: the other endpoints in this Rome's Cloud
 * account, such as the guardian's dots, and the endpoints of accounts linked
 * to it. Read live from Rome Cloud, so a dot is on the People page, and can be
 * linked at a bond level, before it ever messages Rome. Contract: `Accounts`
 * (accounts.ts).
 *
 * An endpoint's address is its name in this Rome's own account and
 * `@slug/endpoint` in another (agentAddress). Cloud keeps a name unique only
 * among current endpoints, so a name freed by a removed dot can return under a
 * new one and carry the old link (I2 holds only while the endpoint lives).
 *
 * Any `@slug/endpoint` address resolves, listed or not: an agent Rome wrote to
 * can answer without a link, and such a sender still has to be an account the
 * guardian can find and place (I4).
 */

import { compareCodePoints } from "@rome/api-types/people";
import {
  type AgentEndpointSummary,
  type AgentMessagingClient,
  agentAddress,
  agentAddressAccount,
} from "../lib/rome-cloud-agents.js";
import { createLogger } from "../logger.js";
import type { Account, AccountId, Accounts } from "./accounts.js";
import { pageAccounts } from "./account-paging.js";

const log = createLogger("agents-accounts");

/** How long one read of Cloud's endpoint list answers. A People page reads the
 *  whole listing and resolves every stored address at once, so this keeps that
 *  to one request. */
const READ_TTL_MS = 30_000;

function toAccount(endpoint: AgentEndpointSummary): Account | null {
  const address = agentAddress(endpoint);
  if (address === null) return null;
  return {
    id: address as AccountId,
    addresses: [address],
    // The address names the endpoint, so it is not repeated as a name.
    name: null,
    identifiers: {
      username: address,
      "agents:kind": endpoint.kind,
      ...(endpoint.sameAccount === false && endpoint.account
        ? { "agents:account": endpoint.account }
        : {}),
    },
  };
}

/** An agent in another account that the listing does not hold. */
function externalAccount(address: string, account: string): Account {
  return {
    id: address as AccountId,
    addresses: [address],
    name: null,
    identifiers: { username: address, "agents:account": account },
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
      ({ endpoint: own, endpoints }) =>
        endpoints
          // A dot still waiting on its pairing confirmation cannot be reached.
          .filter(
            (endpoint) =>
              endpoint.ready && (endpoint.sameAccount === false || endpoint.endpoint !== own),
          )
          .flatMap((endpoint) => toAccount(endpoint) ?? [])
          .sort((a, b) => compareCodePoints(a.id, b.id)),
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
      const listed = (await endpoints()).find((account) => account.id === address);
      if (listed) return listed;
      const account = deps.isConnected() ? agentAddressAccount(address) : null;
      return account ? externalAccount(address, account) : null;
    },
  };
}
