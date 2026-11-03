// What a participant said in a place. Vocabulary: docs/domains/chats.md#message.
//
// A message is its own aggregate: it names its chat by key and the chat never
// holds its messages. It is never rewritten once recorded, except for the
// delivery of a message Rome sends.

import type { Account, Attachment } from "@rome-os/app-runtime";
import type { MessagePart } from "../types.js";
import type { Place } from "./place.js";

/** Every message goes one way: to Rome, or from Rome. */
export type Direction = "toRome" | "fromRome";

/**
 * Who said a message: the account it was said as. A delegate's reply is said
 * as the guardian's account on behalf of the agent `onBehalfOf` names.
 */
export interface SaidBy {
  readonly account: Account;
  /** What the sender was called on the message, as the platform showed it.
   *  The account profile is the lasting name. This is only what the line
   *  carried. */
  readonly name?: string;
  readonly onBehalfOf?: string;
}

/** What a message says. Attachments read as plain text through
 *  {@link plainText}, so every reader can follow the chat. */
export interface Body {
  readonly text: string;
  readonly attachments?: readonly Attachment[];
}

/**
 * A message that reached Rome. `platformMessageId` is the platform's own id
 * for it, which makes recording it again a no-op. `replyTo` is the platform id
 * of the message it quotes, when it quotes one.
 */
export interface InboundMessage {
  readonly direction: "toRome";
  readonly place: Place;
  readonly saidBy: SaidBy;
  readonly body: Body;
  readonly platformMessageId: string;
  readonly replyTo?: string;
  readonly at: Date;
}

/** A message for {@link MessageRepository.record}: one that reached Rome. */
export type Message = InboundMessage;

/**
 * A message Rome said, which its platform took or may have taken. Rome's
 * account in the place is the one the message went out from, so it is not
 * named here. `parts` is the message as it was composed, which reads as plain
 * text the way any recorded message does.
 *
 * `platformMessageId` is the platform's id for the message, absent while its
 * send is unsettled. A reply the platform showed as several messages names
 * the one it starts with there and the rest in `otherPlatformMessageIds`, so
 * a quote of any of them reaches it. `replyTo` is the platform id of the
 * message it answers.
 *
 * `turnId` names the agent turn that said it, an id in Agents that Chats
 * keeps and never reads. `turnAnswer` says the turn holds the message as its
 * own answer. Otherwise the agent learns of it as something said in the chat,
 * like a message it was away for.
 */
export interface OutboundMessage {
  readonly direction: "fromRome";
  readonly place: Place;
  readonly parts: readonly MessagePart[];
  readonly platformMessageId?: string;
  readonly otherPlatformMessageIds?: readonly string[];
  readonly replyTo?: string;
  readonly turnId?: string;
  readonly turnAnswer: boolean;
}

/** A message once it is on record: the id Rome gave it. */
export type RecordedMessage = Message & { readonly id: string };

/**
 * A message as a read of its place finds it, either way it went. Over today's
 * storage an agent's reply is on record from the end of its turn, before its
 * send settles, so one the platform refused can still be read
 * (docs/domains/chats.md#delivery).
 *
 * `saidBy` is absent when the record kept no account for the message: an
 * older row, or one of Rome's lines on a channel that has no account of its
 * own. `senderName` is what the line called its sender, kept even then, so a
 * reader can still say who spoke. `turnId` names the agent turn that said the message or was woken by
 * it. It is an id in Agents, which Chats keeps and never reads.
 */
export interface SaidMessage {
  readonly id: string;
  readonly direction: Direction;
  readonly place: Place;
  readonly saidBy?: SaidBy;
  readonly senderName?: string;
  readonly body: Body;
  readonly platformMessageId?: string;
  readonly replyTo?: string;
  readonly at: Date;
  readonly turnId?: string;
}

/**
 * A message to Rome. Refuses a sender on another platform than the place,
 * since a chat's participants are all on its platform, and a message with no
 * platform id, since nothing could tell a redelivery from a new message.
 */
export function messageToRome(input: Omit<InboundMessage, "direction">): InboundMessage {
  if (input.saidBy.account.platform !== input.place.chat.platform) {
    throw new Error(
      `A message in a ${input.place.chat.platform} chat cannot be said by a ${input.saidBy.account.platform} account`,
    );
  }
  if (!input.platformMessageId) {
    throw new Error("A message to Rome needs the platform's id for it");
  }
  return { direction: "toRome", ...input };
}

/**
 * The body as one plain-text line set: the text, then a line for each
 * attachment Rome saved, naming where it is. An attachment Rome has not saved
 * has nothing to point at and adds no line.
 */
export function plainText(body: Body): string {
  const saved = (body.attachments ?? []).filter(
    (attachment) => typeof attachment.localPath === "string" && attachment.localPath.trim(),
  );
  const text = body.text.trim();
  if (saved.length === 0) return text;
  const lines = saved.map((attachment, index) => {
    const name = attachment.fileName ? ` ${attachment.fileName}` : "";
    const caption = attachment.caption ? ` caption: ${attachment.caption}` : "";
    return `Attachment ${index + 1} (${attachment.type}${name}) path: ${attachment.localPath}${caption}`;
  });
  return [text, lines.join("\n")].filter(Boolean).join("\n\n").trim();
}
