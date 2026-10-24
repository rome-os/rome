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

/** One part of a stored WebChat message's content. */
export type TranscriptPart = MessagePart | HandbackApprovedPart | StoredErrorPart;

/** The person who sent a WebChat user message, as the dashboard shows them.
 * Absent when the message recorded no sender: one sent before senders were
 * recorded, or one an agent or a channel wrote. `name` is the guardian's name
 * or the visitor's email, null when neither is known. */
export type ChatMessageSender =
  | { kind: "guardian"; name: string | null; avatarUrl: string | null }
  | { kind: "visitor"; accountId: string; name: string | null; avatarUrl: string | null };
