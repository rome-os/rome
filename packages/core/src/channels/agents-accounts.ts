/**
 * The Agents channel's address book: the other endpoints in this Rome's Cloud
 * account, such as the guardian's dots. Read live from Rome Cloud, so a dot is
 * on the People page, and can be linked at a bond level, before it ever
 * messages Rome. Contract: `Accounts` (accounts.ts).
 *
 * An endpoint's name is its address. Cloud keeps it unique only among current
 * endpoints, so a name freed by a removed dot can return under a new one and
 * carry the old link (I2 holds only while the endpoint lives).
 */

import { compareCodePoints } from "@rome/api-types/people";
import type { AgentEndpointSummary, AgentMessagingClient } from "../lib/rome-cloud-agents.js";
import { createLogger } from "../logger.js";
import type { Account, AccountId, Accounts } from "./accounts.js";
import { pageAccounts } from "./account-paging.js";

const log = createLogger("agents-accounts");

/** How long one read of Cloud's endpoint list answers. A People page reads the
 *  whole listing and resolves every stored address at once, so this keeps that
 *  to one request. */
const READ_TTL_MS = 30_000;

function toAccount(endpoint: AgentEndpointSummary): Account {
  return {
    id: endpoint.endpoint as AccountId,
    addresses: [endpoint.endpoint],
    // The endpoint name is the address, so it is not repeated as a name.
    name: null,
    identifiers: { username: endpoint.endpoint, "agents:kind": endpoint.kind },
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
          .filter((endpoint) => endpoint.ready && endpoint.endpoint !== own)
          .map(toAccount)
          .sort((a, b) => compareCodePoints(a.id, b.id)),
      // Every address book is read for every People page, so an unreachable
      // Cloud lists no agents rather than failing the page.
      (err: unknown) => {
        log.warn("Could not list agent endpoints", {
          error: err instanceof Error ? err.message : String(err),
        });
        read = null;
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
      return (await endpoints()).find((account) => account.id === address) ?? null;
    },
  };
}
