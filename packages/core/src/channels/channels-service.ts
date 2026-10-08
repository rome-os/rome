/**
 * `ChannelsService`: the channels this Rome has, by name, for app actions.
 * An action sends and reads through it the same way in the main process and in
 * a worker (where `ChannelsServiceProxy` reaches this one over RPC).
 *
 * Connections are the service's own business. It picks the one backing a
 * channel, or the one an action names when several do, and nothing above it
 * holds a Connection id for anything but that choice.
 */

import type {
  ChannelHistoryRead,
  ChannelMessage,
  ChannelMessageQuery,
  ChannelSummary,
  ChannelsService,
  ConversationId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import { chooseConnection, connectionRefusalMessage } from "@rome-os/app-runtime";
import type { ConnectionRegistry } from "../connections/registry.js";
import type { Channels } from "./channel.js";
import { readTalkHistory } from "./talk-history.js";

export interface ChannelsServiceDeps {
  /** The channel list, or undefined until it is built. It is built after the
   *  services that hand this one out, and until then `list` names only the
   *  channels a Connection backs, `send` works, and nothing reads messages. */
  channels: () => Channels | undefined;
  /** The Connections that back sending and live history. */
  registry: Pick<ConnectionRegistry, "all" | "get">;
}

export function createChannelsService(deps: ChannelsServiceDeps): ChannelsService {
  const find = (name: string) => deps.channels()?.find((channel) => channel.name === name);

  /** Every Connection that can talk, whether or not it is unlocked now. */
  const talking = () =>
    deps.registry.all().filter((connection) => connection.status().talk.state !== "unsupported");

  /** The Connection an action means: the one it names, which must back the
   *  channel, or else the only one that does. */
  async function connectionFor(channel: string, requested?: string): Promise<string> {
    const backing = talking()
      .filter((connection) => connection.service === channel)
      .map((connection) => connection.id);
    const choice = chooseConnection(backing, requested);
    if ("refused" in choice) {
      throw new Error(connectionRefusalMessage(channel, choice.refused, requested));
    }
    return choice.connectionId;
  }

  return {
    async list(): Promise<ChannelSummary[]> {
      const summaries = new Map<string, ChannelSummary>();
      for (const { id, service } of talking()) {
        const summary = summaries.get(service) ?? { name: service, connectionIds: [] };
        summary.connectionIds.push(id);
        summaries.set(service, summary);
      }
      for (const channel of deps.channels() ?? []) {
        if (!summaries.has(channel.name)) {
          summaries.set(channel.name, { name: channel.name, connectionIds: [] });
        }
      }
      return [...summaries.values()];
    },

    async send(
      channel: string,
      conversationId: ConversationId,
      message: OutgoingMessage,
      options?: { connectionId?: string },
    ): Promise<MessageReceipt> {
      const connectionId = await connectionFor(channel, options?.connectionId);
      const talk = deps.registry.get(connectionId).talk;
      if (!talk) throw new Error(`Talk is unavailable for connection "${connectionId}"`);
      return talk.send(conversationId, message);
    },

    async query(channel: string, query: ChannelMessageQuery = {}): Promise<ChannelMessage[]> {
      const messages = find(channel)?.messages;
      if (!messages) throw new Error(`Channel "${channel}" reads no messages`);
      return messages.query(query);
    },

    async history(channel: string, input: ChannelHistoryRead): Promise<ChannelMessage[]> {
      const connectionId = await connectionFor(channel, input.connectionId);
      return readTalkHistory(
        {
          channel: find(channel),
          connectionHistory: deps.registry.get(connectionId).talk?.history ?? null,
        },
        connectionId,
        {
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
          ...(input.since ? { since: input.since } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        },
      );
    },
  };
}
