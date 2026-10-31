// A channel's send port as an app's hook gets it: whatever the app sends on
// it goes through the chat adapter of the seat at that address and is
// recorded in Chats, as every other send Rome makes is. Contract:
// docs/architecture/channels.md#chat-adapters.

import type { Channel, ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import type { ChannelSend } from "../channels/channel.js";
import { createLogger } from "../logger.js";
import type { SeatReplies } from "../sessions/seat-replies.js";
import type { ChatRepository } from "./chat-repository.js";
import { ChatIds } from "../channels/chat-ids.js";
import { openChannelChat, type OpenChannelChatDeps } from "./open-chat.js";
import { chatKey } from "./place.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";

const log = createLogger("recorded-sends");

export interface RecordedSendsDeps extends Omit<OpenChannelChatDeps, "webchatRepo" | "chats"> {
  chats: Pick<ChatRepository, "get" | "start">;
  webchatRepo: Pick<WebChatRepository, "ensureChannelChat" | "seatAt">;
  replies: Pick<SeatReplies, "send">;
}

/**
 * `channels` with each send port saying what is sent through the seat at the
 * address it is sent to: the seat that heard that address, else the chat Rome
 * holds there, opened for the main agent. The dashboard records its own
 * lines, and an email is sent on the port as it was, since the chat adapter
 * carries no email.
 */
export function recordedSends<C extends Channel>(
  channels: readonly C[],
  deps: RecordedSendsDeps,
): C[] {
  return channels.map((channel) => {
    const send = channel.send as ChannelSend | null | undefined;
    if (!send || channel.name === "webchat") return channel;
    const wrapped = Object.create(send) as ChannelSend;
    Object.defineProperty(wrapped, "send", {
      value: async (address: ChatId, message: OutgoingMessage): Promise<MessageReceipt> => {
        if ("kind" in message && message.kind === "email") return send.send(address, message);
        const sessionId = await seatAt(deps, channel.name, address);
        const said = await deps.replies.send(
          sessionId,
          channel,
          {
            text: message.text ?? "",
            ...(message.parts?.length ? { parts: message.parts } : {}),
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          },
          {
            ...(message.turnId ? { turnId: message.turnId } : {}),
            ...(message.replyToMessageId
              ? { replyToPlatformMessageId: message.replyToMessageId }
              : {}),
          },
        );
        if (!said) {
          log.warn("send has no seat to record it in", { channel: channel.name });
          return send.send(address, message);
        }
        return {
          chatId: address,
          ...(said.platformMessageId ? { messageId: said.platformMessageId } : {}),
        };
      },
    });
    return { ...channel, send: wrapped } as C;
  });
}

/** The seat a send to `address` on `channel` is said through. */
async function seatAt(deps: RecordedSendsDeps, channel: string, address: ChatId): Promise<string> {
  const heard = deps.webchatRepo.seatAt(channel, address);
  if (heard) return heard;
  const account = deps.accountOf(channel);
  const platform = account?.platform ?? deps.platformOfChannel(channel);
  // A group Rome holds is named by its address; anything else at an address
  // is a direct message, as an app's send without a seat has always meant.
  const group = deps.chats.get(ChatIds.chat(chatKey(platform, address)));
  const opened = await openChannelChat(
    { ...deps, webchatRepo: deps.webchatRepo },
    {
      channel,
      threadId: address,
      agentName: "main",
      threadType: group && group.kind === "group" ? "group" : "private",
    },
  );
  return opened.id;
}
