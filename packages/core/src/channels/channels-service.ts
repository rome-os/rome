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
import type { TalkRouter } from "../connections/types.js";
import type { Channels } from "./channel.js";

export interface ChannelsServiceDeps {
  /** The channel list, or undefined until it is built. It is built after the
   *  services that hand this one out, and until then `list` names only the
   *  channels a Connection backs, `send` works, and nothing reads messages. */
  channels: () => Channels | undefined;
  /** The Connections that back sending. */
  router: Pick<TalkRouter, "list" | "send">;
}

/** The `query` a deprecated `history` read makes. `history` answers the same
 *  page oldest first, and the Connection it names is not consulted: the
 *  channel's `messages` answers for whichever Connection backs it. */
export function historyQuery(input: ChannelHistoryRead): ChannelMessageQuery {
  return {
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.since ? { since: input.since } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  };
}

export function createChannelsService(deps: ChannelsServiceDeps): ChannelsService {
  const find = (name: string) => deps.channels()?.find((channel) => channel.name === name);

  /** The Connection an action means: the one it names, which must back the
   *  channel, or else the only one that does. */
  async function connectionFor(channel: string, requested?: string): Promise<string> {
    const backing = (await deps.router.list())
      .filter((connection) => connection.service === channel)
      .map((connection) => connection.connectionId);
    const choice = chooseConnection(backing, requested);
    if ("refused" in choice) {
      throw new Error(connectionRefusalMessage(channel, choice.refused, requested));
    }
    return choice.connectionId;
  }

  async function query(channel: string, read: ChannelMessageQuery = {}): Promise<ChannelMessage[]> {
    const messages = find(channel)?.messages;
    if (!messages) throw new Error(`Channel "${channel}" reads no messages`);
    return messages.query(read);
  }

  return {
    async list(): Promise<ChannelSummary[]> {
      const summaries = new Map<string, ChannelSummary>();
      for (const { connectionId, service } of await deps.router.list()) {
        const summary = summaries.get(service) ?? { name: service, connectionIds: [] };
        summary.connectionIds.push(connectionId);
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
      return deps.router.send(connectionId, conversationId, message);
    },

    query,

    /** @deprecated Use `query`. */
    async history(channel: string, input: ChannelHistoryRead): Promise<ChannelMessage[]> {
      return (await query(channel, historyQuery(input))).reverse();
    },
  };
}
