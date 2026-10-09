/**
 * Who a channel can reach, by name, for the one action that turns a name into
 * an address: `system:send_message`, when it sends to an agent by name. It is
 * handed to the system app alone, since a channel's address book holds the guardian's contacts (phone
 * numbers, LinkedIn members), and no other app gets a searchable list of them.
 *
 * It reads the channel's own address book (`Channel.accounts`), the one the
 * People page reads, and adds no path to the platform behind it.
 */

import type { ConnectionRegistry } from "../connections/registry.js";
import type { Channels } from "./channel.js";
import { backingConnection } from "./channels-service.js";

/** The most accounts one lookup answers. */
export const MAX_ACCOUNT_LOOKUP = 100;
const DEFAULT_ACCOUNT_LOOKUP = 20;

export interface ChannelAccountLookup {
  /** Whether a Connection backs the channel and is unlocked, so its address
   *  book can answer. A channel that is not connected lists no one, and an
   *  empty answer from it says nothing about who exists. */
  connected: boolean;
  /** Each account's name and addresses. The identifiers a book matches on stay
   *  in core: an address is all a send takes. On `agents` the one address is
   *  the agent's id, the threadId `send_message` takes. */
  accounts: { name: string | null; addresses: string[] }[];
  /** Whether more matched than the lookup returns, so a caller after one
   *  account narrows its query rather than concluding it is absent. */
  more: boolean;
}

export interface ChannelAccountsService {
  /** Up to `limit` (default 20, at most 100) of the channel's accounts whose
   *  name or identifiers contain `query`. Rejects for a channel Rome does not
   *  have and for one with no address book. */
  find(channel: string, read?: { query?: string; limit?: number }): Promise<ChannelAccountLookup>;
}

export function createChannelAccounts(deps: {
  /** The channel list, or undefined until it is built. */
  channels: () => Channels | undefined;
  registry: Pick<ConnectionRegistry, "all">;
}): ChannelAccountsService {
  return {
    async find(name, read = {}) {
      const channels = deps.channels();
      if (!channels) throw new Error("Channels are still starting; try again shortly");
      const channel = channels.find((candidate) => candidate.name === name);
      if (!channel) throw new Error(`Unknown channel "${name}"`);
      if (!channel.accounts) throw new Error(`Channel "${name}" has no address book`);
      const requested = Math.floor(read.limit ?? DEFAULT_ACCOUNT_LOOKUP);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(requested, 1), MAX_ACCOUNT_LOOKUP)
        : DEFAULT_ACCOUNT_LOOKUP;
      const { accounts, nextCursor } = await channel.accounts.listAccounts({
        ...(read.query ? { query: read.query } : {}),
        limit,
      });
      return {
        connected: backingConnection(deps.registry, name)?.status().talk.state === "unlocked",
        accounts: accounts.map((account) => ({ name: account.name, addresses: account.addresses })),
        more: nextCursor !== undefined,
      };
    },
  };
}
