/**
 * The Agents channel's address book: the other endpoints in this Rome's Cloud
 * account, such as the guardian's dots, and the endpoints of accounts linked
 * to it. Read live from Rome Cloud, so a dot is on the People page, and can be
 * linked at a bond level, before it ever messages Rome. Contract: `Accounts`
 * (accounts.ts).
 *
 * An endpoint's address is its name in this Rome's own account and
 * `@handle/endpoint` in another (agentAddress). Cloud keeps a name unique only
 * among current endpoints, so a name freed by a removed dot can return under a
 * new one and carry the old link (I2 holds only while the endpoint lives).
 * Another account's address also carries its handle, which its owner can
 * change: after a rename, its agents arrive under a new address, and the old
 * one resolves at Cloud only through the 30-day hold. The same hold covers
 * this Rome's own old handle, which resolves here as another account's until
 * agents are keyed by Cloud's endpoint id.
 *
 * Any other account's `@handle/endpoint` resolves, listed or not: an agent
 * Rome wrote to can answer without a link, and such a sender still has to be an
 * account the guardian can find and place (I4). An own agent's full address
 * folds onto its bare name.
 */

import { compareCodePoints } from "@rome/api-types/people";
import {
  type AgentEndpointSummary,
  type AgentMessagingClient,
  agentAddress,
  agentAddressAccount,
  canonicalAgentAddress,
} from "../lib/rome-cloud-agents.js";
import { createLogger } from "../logger.js";
import type { AgentSighting } from "./agents-identity.js";
import type { Account, AccountId, Accounts } from "./accounts.js";
import { pageAccounts } from "./account-paging.js";

const log = createLogger("agents-accounts");

/** How long one read of Cloud's endpoint list answers. A People page reads the
 *  whole listing and resolves every stored address at once, so this keeps that
 *  to one request. */
const READ_TTL_MS = 30_000;

/** One read of Cloud's listing, with the handle of this Rome's own account. */
interface Book {
  accounts: Account[];
  ownHandle: string | null;
}

/** An agent's account. Its id is its address; one in this Rome's own account
 *  also answers to the full address Cloud gives it. */
function agentAccount(address: string, more: { kind?: string; fullAddress?: string }): Account {
  const handle = agentAddressAccount(address);
  return {
    id: address as AccountId,
    addresses:
      more.fullAddress && more.fullAddress !== address ? [address, more.fullAddress] : [address],
    // The address names the endpoint, so it is not repeated as a name.
    name: null,
    identifiers: {
      username: address,
      ...(more.kind ? { "agents:kind": more.kind } : {}),
      ...(handle ? { "agents:account": handle } : {}),
    },
  };
}

function toAccount(endpoint: AgentEndpointSummary): Account | null {
  const address = agentAddress(endpoint);
  if (address === null) return null;
  return agentAccount(address, {
    kind: endpoint.kind,
    ...(endpoint.address ? { fullAddress: endpoint.address } : {}),
  });
}

export function agentsAccounts(deps: {
  client: Pick<AgentMessagingClient, "endpoints">;
  /** Whether the guardian has connected Agents. Until then the channel
   *  reaches no one, and Cloud is not asked. */
  isConnected: () => boolean;
  /** Told every listed endpoint Cloud names by id, after each good read. */
  onListed?: (sightings: AgentSighting[]) => void;
  now?: () => number;
}): Accounts {
  const now = deps.now ?? Date.now;
  let read: { at: number; book: Promise<Book> } | null = null;
  // A handle rarely changes, so the last one Cloud named outlives a failed
  // read, and other accounts' addresses keep resolving through an outage.
  let lastOwnHandle: string | null = null;

  function endpoints(): Promise<Book> {
    if (!deps.isConnected()) return Promise.resolve({ accounts: [], ownHandle: null });
    if (read && now() - read.at < READ_TTL_MS) return read.book;
    const book = deps.client.endpoints().then(
      ({ endpoint: own, address, endpoints }) => {
        lastOwnHandle = address ? agentAddressAccount(address) : null;
        deps.onListed?.(
          endpoints.flatMap((endpoint) => {
            const listed = agentAddress(endpoint);
            return endpoint.endpointId && listed !== null
              ? [{ endpointId: endpoint.endpointId, address: listed, at: now() }]
              : [];
          }),
        );
        return {
          accounts: endpoints
            // A dot still waiting on its pairing confirmation cannot be reached.
            .filter(
              (endpoint) =>
                endpoint.ready && (endpoint.sameAccount === false || endpoint.endpoint !== own),
            )
            .flatMap((endpoint) => toAccount(endpoint) ?? [])
            .sort((a, b) => compareCodePoints(a.id, b.id)),
          ownHandle: lastOwnHandle,
        };
      },
      // Every address book is read for every People page, so an unreachable
      // Cloud lists no agents rather than failing the page. The empty answer
      // is kept like any other read, so an outage does not hold each page
      // load for Cloud's timeout.
      (err: unknown) => {
        log.warn("Could not list agent endpoints", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { accounts: [], ownHandle: lastOwnHandle };
      },
    );
    read = { at: now(), book };
    return book;
  }

  return {
    async listAccounts(input) {
      return pageAccounts((await endpoints()).accounts, input);
    },
    async resolve(address) {
      const { accounts, ownHandle } = await endpoints();
      const key = canonicalAgentAddress(address);
      const listed = accounts.find((account) =>
        account.addresses.some((known) => canonicalAgentAddress(known) === key),
      );
      if (listed) return listed;
      // An address in this Rome's own account names one of its own agents,
      // which the listing holds by its bare name or not at all. Until Cloud
      // has named this account's handle, no address can be told apart from
      // an own agent's, so none resolves as another account's.
      const handle = agentAddressAccount(address);
      return handle && ownHandle && handle.toLowerCase() !== ownHandle.toLowerCase()
        ? agentAccount(canonicalAgentAddress(address), {})
        : null;
    },
  };
}
