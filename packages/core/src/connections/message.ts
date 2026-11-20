// What a connection hands Rome when a platform delivers a message.
// Vocabulary: docs/domains/connections.md#message.
//
// Plain platform facts, in the platform's own ids. A connection only
// translates the platform's payload into this shape: it never decides whom a
// message addresses, who the sender is to Rome, or whether anything answers
// it. Chats records its own message from this one, and Participation works out
// the addressing for each of Rome's accounts (participation/addressing.ts).

import type { Attachment, ChatId } from "@rome-os/app-runtime";

/** Where a message was said, as the platform names it. */
export interface MessageWhere {
  /** The chat it was said in. A platform thread that is a chat of its own,
   *  as on Discord, is this chat. */
  readonly chatId: ChatId;
  /** A direct message between the sender and the account that received it,
   *  or a group, channel or other chat with more readers. */
  readonly kind: "direct" | "group";
  /** The chat's or thread's name, when the platform gives one. */
  readonly name?: string;
  /** The platform thread it was said in, when it was said in one: the chat
   *  the thread was opened under, and the account that started it when the
   *  platform says. */
  readonly thread?: { readonly parentChatId: ChatId; readonly startedBy?: string };
  /** The group it was said in, where the platform carries a group's messages
   *  on a direct chat with each sender, as WeChat's bot does. */
  readonly group?: { readonly id: string };
}

/** Who said a message, as the platform names them. */
export interface MessageSender {
  readonly accountId: string;
  /** The name the platform showed with the message. */
  readonly name?: string;
  /** The sender's handle on the platform, such as a username. */
  readonly handle?: string;
  /** A bot account said it. A webhook that speaks for a person is that
   *  person's. Absent where the platform does not tell. */
  readonly isBot?: boolean;
}

/** What a message says. */
export interface MessageContent {
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

/** The earlier message a message quotes or replies to. */
export interface MessageReplyTo {
  readonly messageId: string;
  /** Who said the earlier message, when the platform says. */
  readonly senderAccountId?: string;
  /** The earlier message's text, as the platform sent it along. */
  readonly text?: string;
  /** The earlier sender's name, as the platform sent it along. */
  readonly senderName?: string;
}

/**
 * A message a platform delivered through a connection.
 *
 * - `receivedBy` is the account the platform delivered it to, which is the
 *   connection's own account, in the platform's ids.
 * - `mentions` lists the individual accounts it mentions. Mentions of
 *   everyone, of a channel or of a role are not individual accounts and are
 *   left out. Absent where the connection cannot tell whom a message
 *   mentions, which is not the same as mentioning nobody.
 * - `raw` is the platform's own payload, an opaque token for a feature on the
 *   same platform.
 */
export interface Message {
  readonly id: string;
  readonly where: MessageWhere;
  readonly sender: MessageSender;
  readonly content: MessageContent;
  readonly receivedBy: string;
  readonly mentions?: readonly string[];
  readonly replyTo?: MessageReplyTo;
  readonly saidAt: Date;
  readonly raw?: unknown;
}
