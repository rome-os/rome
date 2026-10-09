/**
 * `ChannelsService`: the channels this Rome has, by name, for app actions.
 * An action sends and reads through it the same way in the main process and in
 * a worker (where `ChannelsServiceProxy` reaches this one over RPC).
 *
 * Connections are the service's own business. A channel is one presence, so
 * at most one Connection backs it (one per service), and nothing above the
 * service names a Connection.
 */

import type {
  ChannelAccountPage,
  ChannelMessage,
  ChannelMessageQuery,
  ChannelSummary,
  ChannelsService,
  ConversationId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import type { ConnectionRegistry } from "../connections/registry.js";
import type { Connection } from "../connections/types.js";
import type { Channels } from "./channel.js";
import { sendThrough } from "./connection-ports.js";
import { withRemovedMembers } from "../lib/removed-members.js";

// TODO(0.8): remove, with the service's and the proxy's uses.
export const REMOVED_SERVICE_MEMBERS: Record<string, string> = {
  history:
    "ChannelsService.history was removed in @rome-os/app-runtime 0.7: read through query, which answers newest first",
};
// TODO(0.8): remove, with the service's and the proxy's uses.
export const REMOVED_SUMMARY_MEMBERS: Record<string, string> = {
  connectionIds:
    "ChannelSummary.connectionIds was removed in @rome-os/app-runtime 0.7: read sendable, and send without naming a Connection",
};

export interface ChannelsServiceDeps {
  /** The channel list, or undefined until it is built. It is built after the
   *  services that hand this one out, and until then `list` names only the
   *  channels a Connection backs, `send` works, and nothing reads messages. */
  channels: () => Channels | undefined;
  /** The Connections that back sending. */
  registry: Pick<ConnectionRegistry, "all">;
}

/** Every Connection that can talk, whether or not it is unlocked now. */
function talking(registry: Pick<ConnectionRegistry, "all">): Connection[] {
  return registry.all().filter((connection) => connection.status().talk.state !== "unsupported");
}

/** The Connection backing a channel, or undefined when none does. A service
 *  holds at most one Connection, so a channel has at most one. */
export function backingConnection(
  registry: Pick<ConnectionRegistry, "all">,
  channel: string,
): Connection | undefined {
  return talking(registry).find((connection) => connection.service === channel);
}

export function createChannelsService(deps: ChannelsServiceDeps): ChannelsService {
  const find = (name: string) => deps.channels()?.find((channel) => channel.name === name);

  async function query(channel: string, read: ChannelMessageQuery = {}): Promise<ChannelMessage[]> {
    const messages = find(channel)?.messages;
    if (!messages) throw new Error(`Channel "${channel}" reads no messages`);
    return messages.query(read);
  }

  return withRemovedMembers<ChannelsService>(
    {
      async list(): Promise<ChannelSummary[]> {
        const summaries = new Map<string, ChannelSummary>();
        for (const { service } of talking(deps.registry)) {
          summaries.set(service, { name: service, sendable: true });
        }
        for (const channel of deps.channels() ?? []) {
          if (!summaries.has(channel.name)) {
            summaries.set(channel.name, { name: channel.name, sendable: false });
          }
        }
        return [...summaries.values()].map((summary) =>
          withRemovedMembers(summary, REMOVED_SUMMARY_MEMBERS),
        );
      },

      async send(
        channel: string,
        conversationId: ConversationId,
        message: OutgoingMessage,
      ): Promise<MessageReceipt> {
        const backing = backingConnection(deps.registry, channel);
        if (!backing) throw new Error(`No Talk connection registered for "${channel}"`);
        return sendThrough(backing, conversationId, message);
      },

      query,

      async accounts(channel, read = {}): Promise<ChannelAccountPage> {
        const found = find(channel);
        if (!found) throw new Error(`Unknown channel "${channel}"`);
        if (!found.accounts) throw new Error(`Channel "${channel}" has no address book`);
        const { accounts, nextCursor } = await found.accounts.listAccounts({
          ...(read.query ? { query: read.query } : {}),
          limit: read.limit ?? 20,
        });
        return {
          accounts: accounts.map((account) => ({
            name: account.name,
            addresses: account.addresses,
          })),
          more: nextCursor !== undefined,
        };
      },
    },
    REMOVED_SERVICE_MEMBERS,
  );
}
