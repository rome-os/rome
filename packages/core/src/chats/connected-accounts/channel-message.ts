// A connection's message as apps receive it, the one point where a Connections
// message becomes the published `ChannelMessage`.
// Vocabulary: docs/domains/connections.md#message,
// docs/domains/participation.md#addressed.
//
// Only connection-ports.ts imports this, which the import rules check
// (lint/rules/contexts.ts): what an app receives is built here and nowhere else.

import type { ChannelMessage, MessageAddressing } from "@rome-os/app-runtime";
import type { Message } from "../../connections/message.js";
import {
  type AddressedRomeBy,
  addressedRomeBy,
  mentionsOthers,
} from "../../participation/addressing.js";

const LEGACY_ADDRESSING: Record<AddressedRomeBy, MessageAddressing> = {
  direct: "direct",
  mention: "mention",
  reply: "reply",
  thread: "bot_thread",
};

/**
 * `message` as apps receive it on channel `channel`. Its `addressing`,
 * `fromBot` and `mentionsOthers` are worked out here for the account that
 * received it, since the connection reports only what the platform said.
 * `addressing` is left out where the connection cannot tell whom a message
 * mentions. `mentionsOthers` means it mentions someone and does not address
 * Rome's account in any way, so a reply to Rome's account that also mentions
 * someone else is addressed to Rome.
 */
export function channelMessageOf(message: Message, channel: string): ChannelMessage {
  const { where, sender, content, replyTo } = message;
  const by = addressedRomeBy(message, message.receivedBy);
  return {
    channel,
    direction: "inbound",
    messageId: message.id,
    chatId: where.chatId,
    ...(where.thread ? { parentChatId: where.thread.parentChatId } : {}),
    senderId: sender.accountId,
    ...(sender.name !== undefined ? { senderDisplayName: sender.name } : {}),
    ...(sender.handle !== undefined ? { senderUsername: sender.handle } : {}),
    text: content.text,
    attachments: [...content.attachments],
    timestamp: message.saidAt,
    ...(replyTo
      ? {
          replyTo: {
            messageId: replyTo.messageId,
            ...(replyTo.text !== undefined ? { content: replyTo.text } : {}),
            ...(replyTo.senderName !== undefined ? { senderName: replyTo.senderName } : {}),
          },
        }
      : {}),
    thread: threadOf(message),
    // A connection that cannot tell whom a message mentions leaves its
    // addressing to the app, as it always has.
    ...(message.mentions !== undefined
      ? { addressing: by === null ? "ambient" : LEGACY_ADDRESSING[by] }
      : {}),
    ...(sender.isBot ? { fromBot: true } : {}),
    ...(by === null && mentionsOthers(message, message.receivedBy) ? { mentionsOthers: true } : {}),
    ...(message.raw !== undefined ? { raw: message.raw } : {}),
  };
}

/** The published thread of `message`: a direct message, a topic under the
 *  chat its platform thread was opened in, or a group. A group's message
 *  carried on a direct chat with its sender reads as said in that group. */
function threadOf({ where }: Message): NonNullable<ChannelMessage["thread"]> {
  if (where.group) return { kind: "group", name: where.group.id };
  const name = where.name !== undefined ? { name: where.name } : {};
  if (where.thread) return { kind: "topic", ...name };
  return { kind: where.kind === "direct" ? "dm" : "group", ...name };
}
