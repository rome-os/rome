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
  ChannelMessage,
  ChannelMessageQuery,
  ChannelSummary,
  ChannelsService,
  ConversationId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import { requireTalk, type ConnectionRegistry } from "../connections/registry.js";
import type { Connection } from "../connections/types.js";
import type { Channels } from "./channel.js";

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

  return {
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
      return [...summaries.values()];
    },

    async send(
      channel: string,
      conversationId: ConversationId,
      message: OutgoingMessage,
    ): Promise<MessageReceipt> {
      const backing = backingConnection(deps.registry, channel);
      if (!backing) throw new Error(`No Talk connection registered for "${channel}"`);
      return requireTalk(backing).send(conversationId, message);
    },

    query,
  };
}
