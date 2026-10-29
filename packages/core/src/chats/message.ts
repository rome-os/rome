// What a participant said in a place. Vocabulary: docs/domains/chats.md#message.
//
// A message is its own aggregate: it names its chat by key and the chat never
// holds its messages. It is never rewritten once recorded, except for the
// delivery of a message Rome sends.

import type { Account, Attachment } from "@rome-os/app-runtime";
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

/** A message for {@link MessageRepository.record}. Only messages to Rome are
 *  recorded through it so far; a send still records its own. */
export type Message = InboundMessage;

/** A message once it is on record: the id Rome gave it. */
export type RecordedMessage = Message & { readonly id: string };

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
