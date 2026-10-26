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
import type { Channel, Channels } from "./channel.js";
import { sendThrough, type ChannelOf } from "./connection-ports.js";
import type { ConnectionPacing } from "./delivery/connection-pacing.js";
import { withRemovedMembers } from "../lib/removed-members.js";
import { parseMessageCursor } from "@rome/api-types/message";
import { channelMessageCursor } from "./messages.js";

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
  /** Channels Rome serves itself, which no Connection backs, such as webchat.
   *  Each sends through its own port, before the channel list is built too. */
  own?: readonly Channel[];
}

/** Every Connection that can talk, whether or not it is unlocked now. */
function talking(registry: Pick<ConnectionRegistry, "all">): Connection[] {
  return registry.all().filter((connection) => connection.status().chat.state !== "unsupported");
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

/** The email Connection inbound mail goes to: the one backing the `email`
 *  channel, or else the oldest email Connection that can talk. An email
 *  account connected after another was removed has its own record, under an
 *  opaque id, so it is found by its connection kind, not by the channel name. */
export function emailConnection(
  registry: Pick<ConnectionRegistry, "all">,
  channelOf: ChannelOf,
): Connection | undefined {
  const emails = talking(registry).filter((connection) => connection.connectionKind === "email");
  return emails.find((connection) => channelOf(connection) === "email") ?? emails[0];
}

export function createChannelsService(deps: ChannelsServiceDeps): ChannelsService {
  const find = (name: string) => deps.channels()?.find((channel) => channel.name === name);

  async function query(channel: string, read: ChannelMessageQuery = {}): Promise<ChannelMessage[]> {
    const messages = find(channel)?.messages;
    if (!messages) throw new Error(`Channel "${channel}" reads no messages`);
    const { after: cursor, ...rest } = read;
    // Paging walks back through one chat; across every chat it has no use.
    if (cursor !== undefined && !rest.chatId)
      throw new Error("A query after a cursor names a chat");
    const after = cursor === undefined ? undefined : parseMessageCursor(cursor);
    if (after === null) throw new Error(`Invalid message cursor: ${cursor}`);
    const page = await messages.query({ ...rest, ...(after ? { after } : {}) });
    return page.map((message) => ({ ...message, cursor: channelMessageCursor(message) }));
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
        for (const channel of deps.own ?? []) {
          const platform = deps.platformOf?.(channel.name) ?? platformOf(channel.name);
          summaries.set(channel.name, { name: channel.name, platform, sendable: !!channel.send });
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
        const own = deps.own?.find((candidate) => candidate.name === channel)?.send;
        if (own) return own.send(chatId, message);
        const backing = backingConnection(deps.registry, channel, deps.channelOf);
        if (!backing) throw new Error(`No Talk connection registered for "${channel}"`);
        return sendThrough(backing, chatId, message, deps.pacing);
      },

      query,
    },
    REMOVED_SERVICE_MEMBERS,
  );
}
