// WebChat transcript part wire types: the parts core stores as a message's
// content, re-exported so web reads the same union core writes.

import type { MessagePart } from "@rome-os/app-runtime";

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

/** One part of a stored WebChat message's content. */
export type TranscriptPart = MessagePart | HandbackApprovedPart;
