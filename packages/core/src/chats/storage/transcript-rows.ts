import type { RomeAgentTranscriptMessageInput } from "../../db/repositories/webchat.js";
import type { MessagePart } from "../../types.js";

/** A transcript row's content: one text part. */
export function textMessageContent(content: string): string {
  const parts: MessagePart[] = [{ type: "text", content }];
  return JSON.stringify(parts);
}

/** The id of a turn's transcript row for one role, so a write is idempotent. */
export function transcriptMessageId(
  sessionId: string,
  turnId: string,
  role: RomeAgentTranscriptMessageInput["role"],
): string {
  return `transcript-message:${sessionId}:${turnId}:${role}`;
}
