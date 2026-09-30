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
  TalkRouter,
} from "@rome-os/app-runtime";
import type { ApprovalCreatedEvent } from "../actions/engine.js";
import { readTalkHistory } from "../actions/talk-history.js";
import type { Channels } from "./channel.js";

export interface ChannelsServiceDeps {
  /** The channel list. A function, because the list is built after the
   *  services that hand this one out. */
  channels: () => Channels;
  /** The Connections that back sending and live history. */
  router: Pick<TalkRouter, "list" | "send" | "feature">;
}

export function createChannelsService(deps: ChannelsServiceDeps): ChannelsService {
  const find = (name: string) => deps.channels().find((channel) => channel.name === name);

  /** The Connection an action means: the one it names, which must back the
   *  channel, or else the only one that does. */
  async function connectionFor(channel: string, requested?: string): Promise<string> {
    const backing = (await deps.router.list())
      .filter((connection) => connection.service === channel)
      .map((connection) => connection.connectionId);
    if (requested) {
      if (!backing.includes(requested)) {
        throw new Error(`Connection "${requested}" does not provide channel "${channel}"`);
      }
      return requested;
    }
    if (backing.length === 0) throw new Error(`No Talk connection registered for "${channel}"`);
    if (backing.length > 1) {
      throw new Error(`Channel "${channel}" has multiple connections; connectionId is required`);
    }
    return backing[0]!;
  }

  return {
    async list(): Promise<ChannelSummary[]> {
      const summaries = new Map<string, ChannelSummary>();
      for (const { connectionId, service } of await deps.router.list()) {
        const summary = summaries.get(service) ?? { name: service, connectionIds: [] };
        summary.connectionIds.push(connectionId);
        summaries.set(service, summary);
      }
      for (const channel of deps.channels()) {
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
          connectionHistory: deps.router.feature(connectionId, "history"),
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

/**
 * Put an approval's card in the conversation the approval came from, through
 * the Connection that conversation arrived on, or the channel's only one.
 * Nothing is sent for an approval with no conversation, or on a channel where
 * that Connection cannot be told.
 */
export async function sendApprovalCard(
  channels: Pick<ChannelsService, "list" | "send">,
  { approvalId, actionName, preview, channelContext }: ApprovalCreatedEvent,
): Promise<void> {
  if (!channelContext) return;
  const backing =
    (await channels.list()).find((channel) => channel.name === channelContext.channel)
      ?.connectionIds ?? [];
  const connectionId =
    channelContext.connectionId ?? (backing.length === 1 ? backing[0] : undefined);
  if (!connectionId) return;
  const payload = preview ?? {
    kind: "generic" as const,
    title: actionName,
    summary: `The agent wants to run "${actionName}" and needs your approval.`,
  };
  await channels.send(
    channelContext.channel,
    channelContext.threadId as ConversationId,
    {
      parts: [
        {
          type: "approval_card",
          approvalId,
          actionName,
          preview: payload,
          status: "pending",
        },
      ],
    },
    { connectionId },
  );
}
