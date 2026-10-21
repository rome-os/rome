/**
 * `ChannelsService`: the channels this Rome has, by name, for app actions.
 * An action sends and reads through it the same way in the main process and in
 * a worker (where `ChannelsServiceProxy` reaches this one over RPC).
 *
 * Connections are the service's own business. A channel is one presence, so
 * at most one Connection backs it, and nothing above the service names a
 * Connection.
 */

import type {
  ChannelMessage,
  ChannelMessageQuery,
  ChannelSummary,
  ChannelsService,
  ChatId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import type { ConnectionRegistry } from "../connections/registry.js";
import { platformOf } from "./platform.js";
import type { Connection } from "../connections/types.js";
import type { Channels } from "./channel.js";
import { sendThrough, type ChannelOf } from "./connection-ports.js";
import type { ConnectionPacing } from "./delivery/connection-pacing.js";
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
  /** Names the channel each Connection backs. A Connection it answers null
   *  for backs no channel and is skipped. */
  channelOf: ChannelOf;
  /** The platform a channel is an account on, or null where no record names
   *  one. A backed channel no record names reads its Connection's. */
  platformOf?: (channel: string) => string | null;
  /** Paces a send while reply streaming is on. */
  pacing?: ConnectionPacing;
}

/** Every Connection that can talk, whether or not it is unlocked now. */
function talking(registry: Pick<ConnectionRegistry, "all">): Connection[] {
  return registry.all().filter((connection) => connection.status().talk.state !== "unsupported");
}

/** The Connection backing a channel, or undefined when none does. A channel
 *  is one presence, so at most one Connection backs it. */
export function backingConnection(
  registry: Pick<ConnectionRegistry, "all">,
  channel: string,
  channelOf: ChannelOf,
): Connection | undefined {
  return talking(registry).find((connection) => channelOf(connection) === channel);
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
        for (const connection of talking(deps.registry)) {
          const name = deps.channelOf(connection);
          if (name === null) continue;
          const platform = deps.platformOf?.(name) ?? platformOf(connection.connectionKind);
          summaries.set(name, { name, platform, sendable: true });
        }
        for (const channel of deps.channels() ?? []) {
          if (!summaries.has(channel.name)) {
            const platform = deps.platformOf?.(channel.name) ?? undefined;
            summaries.set(channel.name, {
              name: channel.name,
              ...(platform ? { platform } : {}),
              sendable: false,
            });
          }
        }
        return [...summaries.values()].map((summary) =>
          withRemovedMembers(summary, REMOVED_SUMMARY_MEMBERS),
        );
      },

      async send(
        channel: string,
        chatId: ChatId,
        message: OutgoingMessage,
      ): Promise<MessageReceipt> {
        const backing = backingConnection(deps.registry, channel, deps.channelOf);
        if (!backing) throw new Error(`No Talk connection registered for "${channel}"`);
        return sendThrough(backing, chatId, message, deps.pacing);
      },

      query,
    },
    REMOVED_SERVICE_MEMBERS,
  );
}
