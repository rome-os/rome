// A channel's send port as an app's hook gets it: whatever the app sends on
// it goes through the chat adapter of the seat at that address and is
// recorded in Chats, as every other send Rome makes is. Contract:
// docs/architecture/channels.md#chat-adapters.

import type { Channel, ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import type { ChannelSend } from "../channels/channel.js";
import type { SeatReplies } from "../sessions/seat-replies.js";
import type { ChatRepository } from "./chat-repository.js";
import type { ChatAddresses } from "../channels/chat-addresses.js";
import { ChatIds } from "../channels/chat-ids.js";
import { channelAdapter, platformIdOfLine, type Outbound } from "./adapter.js";
import type { MessageRepository } from "./message-repository.js";
import { startChannelChat, type OpenChannelChatDeps } from "./open-chat.js";
import { chatKey, ownedBy, placeIn } from "./place.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";

export interface RecordedSendsDeps
  extends Omit<OpenChannelChatDeps, "webchatRepo" | "chats" | "addresses"> {
  /** The channels layer's address store: where a direct message was heard,
   *  both ways. */
  addresses: Pick<ChatAddresses, "keyAt" | "bind" | "addressOf">;
  chats: Pick<ChatRepository, "get" | "start">;
  webchatRepo: Pick<WebChatRepository, "seatAt">;
  replies: Pick<SeatReplies, "send">;
  messages: Pick<MessageRepository, "send">;
}

/**
 * `channels` with each send port saying what is sent through the account's
 * chat adapter, and recording it: through the seat that heard the address,
 * else in the chat Rome holds there, started when it holds none, with no
 * session opened. The dashboard records its own lines, and an email is sent
 * on the port as it was, since the chat adapter carries no email.
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
        const out = {
          text: message.text ?? "",
          ...(message.parts?.length ? { parts: message.parts } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        };
        const seat = deps.webchatRepo.seatAt(channel.name, address);
        const platformMessageId = seat
          ? await sayInSeat(deps, channel, seat, out, message)
          : await sayInChat(deps, channel, address, out, message);
        return { chatId: address, ...(platformMessageId ? { messageId: platformMessageId } : {}) };
      },
    });
    return { ...channel, send: wrapped } as C;
  });
}

/** Say `out` through seat `sessionId`, which heard the address. Throws when
 *  the seat stands in no chat, rather than sending a line nobody can read
 *  back. */
async function sayInSeat(
  deps: RecordedSendsDeps,
  channel: Channel,
  sessionId: string,
  out: Outbound,
  message: OutgoingMessage,
): Promise<string | null> {
  const said = await deps.replies.send(sessionId, channel, out, {
    ...(message.turnId ? { turnId: message.turnId } : {}),
    ...(message.replyToMessageId ? { replyToPlatformMessageId: message.replyToMessageId } : {}),
  });
  if (!said) throw new Error(`Session ${sessionId} stands in no chat to send in`);
  return said.platformMessageId;
}

/**
 * Say `out` at an address no seat of the account heard: in the chat Rome
 * holds there, started when it holds none, as Rome's main agent. No session
 * opens, since no agent is in the chat until a message there wakes one. A
 * group Rome holds is named by its address; anything else at an address is a
 * direct message.
 */
async function sayInChat(
  deps: RecordedSendsDeps,
  channel: Channel,
  address: ChatId,
  out: Outbound,
  message: OutgoingMessage,
): Promise<string | null> {
  const known = deps.accountOf(channel.name);
  const platform = known?.platform ?? deps.platformOfChannel(channel.name);
  const group = deps.chats.get(ChatIds.chat(chatKey(platform, address)));
  const { chatId, romeEnd } = startChannelChat(deps, {
    channel: channel.name,
    threadId: address,
    threadType: group?.kind === "group" ? "group" : "private",
  });
  const chat = { platform, id: chatId };
  const account = { platform, id: romeEnd };
  const adapter = channelAdapter(channel, {
    accountOf: () => account,
    platformOfChannel: () => platform,
    addresses: deps.addresses,
  });
  const replyTo = message.replyToMessageId
    ? ChatIds.message(chat, ownedBy(ChatIds.key(chat), romeEnd, message.replyToMessageId))
    : undefined;
  let lineId: string | null = null;
  await deps.messages.send(
    {
      direction: "fromRome",
      place: placeIn(chat),
      saidBy: { account, agent: "main" },
      parts: out.parts ?? [{ type: "text", content: out.text }],
      ...(replyTo ? { replyTo } : {}),
    },
    async () => {
      lineId = await adapter.send(chatId, null, { ...out, ...(replyTo ? { replyTo } : {}) });
      return { id: lineId };
    },
  );
  return lineId === null ? null : platformIdOfLine(chat, romeEnd, lineId);
}
