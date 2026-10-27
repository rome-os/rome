// WebChat transcript part wire types: the parts core stores as a message's
// content, re-exported so web reads the same union core writes.

import type { MessagePart } from "@rome-os/app-runtime";
import type { TraceErrorEvent } from "./trace-segments.js";

export type {
  ApprovalCardStatus,
  MessagePart,
  PreviewPayload,
  RoutineDraftSpec,
} from "@rome-os/app-runtime";

/** Marker core stores when a handoff specialist relays the guardian's verbal
 * approval of the standing submission. Only WebChat writes it, so it is not a
 * channel-facing {@link MessagePart}. */
export interface HandbackApprovedPart {
  type: "handback_approved";
}

/** Error core stores as a turn's assistant content when model resolution fails
 * before the turn runs. It carries the trace error event's fields. */
export type StoredErrorPart = Pick<
  TraceErrorEvent,
  "type" | "error" | "code" | "provider" | "reason"
>;

/** A text part as WebChat stores it. `format` is a display hint only the
 * `say` tool sets: `long` shows the text as one long message, `bubble` or
 * absent as a chat bubble where the chat shows bubbles. */
export type WebchatTextPart = Extract<MessagePart, { type: "text" }> & {
  format?: "bubble" | "long";
};

/** A card for a chat that another agent's tool started on the guardian's
 * behalf. The chat's live status is read from the chat itself. */
export interface TaskChatPart {
  type: "task_chat";
  chatId: string;
  title: string;
}

/** Longest `text` a {@link ReplyToPart} keeps; core truncates longer snapshots with an ellipsis. */
export const REPLY_TO_TEXT_MAX_LENGTH = 1000;

/** The message a user message replies to, snapshotted when it was sent. It is
 * the first part of the reply, so the quote stays whole after the original
 * leaves the transcript. `text` is the quoted selection or the whole message. */
export interface ReplyToPart {
  type: "reply_to";
  messageId: string;
  author: "guardian" | "agent";
  name?: string;
  text: string;
}

/** One part of a stored WebChat message's content. */
export type TranscriptPart =
  | Exclude<MessagePart, { type: "text" }>
  | WebchatTextPart
  | HandbackApprovedPart
  | StoredErrorPart
  | TaskChatPart
  | ReplyToPart;

/** The person who sent a WebChat user message, as the dashboard shows them.
 * Absent when the message recorded no sender: one sent before senders were
 * recorded, or one an agent or a channel wrote. `name` is the guardian's name
 * or the visitor's email, null when neither is known. */
export type ChatMessageSender =
  | { kind: "guardian"; name: string | null; avatarUrl: string | null }
  | { kind: "visitor"; accountId: string; name: string | null; avatarUrl: string | null };
