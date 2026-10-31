// What a participant said in a place. Vocabulary: docs/domains/chats.md#message.
//
// A message is its own aggregate: it names its chat by key and the chat never
// holds its messages. It is never rewritten once recorded. It names no turn:
// which turn took or gave it is Agents' link (`agent_turn_messages`).

import type { Account, Attachment } from "@rome-os/app-runtime";
import type { MessagePart } from "../types.js";
import type { Place } from "./place.js";

/** Every message goes one way: to Rome, or from Rome. */
export type Direction = "toRome" | "fromRome";

/**
 * Who said a message: the account it was said as. `agent` is the one of
 * Rome's agents that said it, set on exactly the messages from Rome; under
 * the guardian's account it is the delegate speaking on their behalf.
 */
export interface SaidBy {
  readonly account: Account;
  /** What the sender was called on the message, as the platform showed it.
   *  The account profile is the lasting name. This is only what the line
   *  carried. */
  readonly name?: string;
  readonly agent?: string;
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
  /** The id to record it under, when the caller needs it before the record
   *  exists. Absent, Rome gives one. */
  readonly id?: string;
  readonly place: Place;
  readonly saidBy: SaidBy;
  readonly body: Body;
  /** The message as composed, where the platform carries more than text,
   *  as the dashboard does. Absent, the body's text is its one part. */
  readonly parts?: readonly MessagePart[];
  readonly platformMessageId: string;
  readonly replyTo?: string;
  readonly at: Date;
}

/** A message for {@link MessageRepository.record}. */
export type Message = InboundMessage;

/**
 * A message Rome says into a place. `saidBy` is the account it goes out as,
 * one of Rome's own or the guardian's, with the agent that said it when an
 * agent did. `parts` is the message as composed, which reads as plain text
 * the way any recorded message does. `replyTo` is the platform id of the
 * message it answers.
 */
export interface OutboundMessage {
  readonly direction: "fromRome";
  /** The id to record it under, when the caller needs it before the send
   *  answers. Absent, Rome gives one. */
  readonly id?: string;
  readonly place: Place;
  readonly saidBy: SaidBy;
  readonly parts: readonly MessagePart[];
  readonly replyTo?: string;
}

/** A message once it is on record: the id Rome gave it. */
export type RecordedMessage = Message & { readonly id: string };

/**
 * A message as a read of its place finds it, either way it went. It is from
 * Rome when `saidBy.agent` is set. `saidBy` is absent when the record kept no
 * account for it, as on some older lines. `senderName` is what the line
 * called its sender, kept even then. `parts` is the message as composed, as
 * JSON, for readers that draw its widgets.
 */
export interface SaidMessage {
  readonly id: string;
  readonly direction: Direction;
  readonly place: Place;
  readonly saidBy?: SaidBy;
  readonly senderName?: string;
  readonly body: Body;
  readonly parts: string;
  readonly platformMessageId?: string;
  readonly replyTo?: string;
  readonly at: Date;
}

/**
 * A message to Rome. Refuses a sender on another platform than the place,
 * since everyone in a chat is on its platform, and a message with no
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

/** The plain text of composed `parts`: their text parts, one per line. A
 *  turn's narration on its way to the answer (a commentary part) is no line
 *  of the chat. */
export function partsText(parts: readonly MessagePart[]): string {
  return parts
    .flatMap((part) =>
      part.type === "text" && part.turnPhase !== "commentary" ? [part.content] : [],
    )
    .join("\n");
}
