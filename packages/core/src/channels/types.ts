import type { NormalizedMessage } from "../types.js";

export type {
  NormalizedMessage,
  Attachment,
  MessageReplyReference,
  OutgoingMessage,
  OutgoingAttachment,
} from "../types.js";

/** One line of an adapter's history read, with whether the account the
 *  Connection speaks as wrote it — decided by the read, carried with the line. */
export interface HistoryLine {
  message: NormalizedMessage;
  own: boolean;
}
