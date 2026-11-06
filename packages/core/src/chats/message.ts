// What a participant said in a place, as a page read of it finds it.
// Vocabulary: docs/domains/chats.md#message. Chats records and reads messages
// in chats/storage/; this is the shape the concierge's task chat reads.

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
   *  The account profile is the lasting name. This is only what the message
   *  carried. */
  readonly name?: string;
  readonly onBehalfOf?: string;
}

/** What a message says: its text and the attachments it carried. */
export interface Body {
  readonly text: string;
  readonly attachments?: readonly Attachment[];
}

/**
 * A message as a read of its place finds it, either way it went. Over today's
 * storage an agent's reply is on record from the end of its turn, before its
 * send settles, so one the platform refused can still be read
 * (docs/domains/chats.md#delivery).
 *
 * `saidBy` is absent when the record kept no account for the message: an
 * older row, or one of Rome's messages on a channel that has no account of its
 * own. `senderName` is what the message called its sender, kept even then, so a
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
