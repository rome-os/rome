// A row of the LinkedIn mirror as the message it records. Shared by the
// channel's `query` (linkedin-messages.ts) and the Connection's history read,
// so the two cannot render one row two ways.

import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import { linkedInMemberIdFromProfileUrl, type LinkedInHistoryMessage } from "./linkedin-sync.js";

/**
 * The `channel_mappings.channel_user_id` a LinkedIn message resolves through.
 *
 * The bare member id is the address the mirror keys on — `linkedin_participants`
 * is primary-keyed by it and promotion writes it into the mapping — so a promoted
 * participant is recognised on their next message with nothing else wired up.
 *
 * The stored profile URL stays the fallback rather than being replaced by one:
 * a URL carrying no member id is a vanity handle (`/in/ada-lovelace`), which is
 * the form the guardian's own mapping is conferred in at connect time. Narrowing
 * to the member id alone would strand it.
 */
export function linkedInChannelUserId(row: LinkedInHistoryMessage): string {
  return (
    linkedInMemberIdFromProfileUrl(row.senderProfileUrl) ??
    row.senderProfileUrl ??
    (row.senderIsSelf ? "linkedin:self" : "linkedin:unknown")
  );
}

/** The line a mirrored row reads as: an InMail's subject above its body. */
export function linkedInHistoryText(row: LinkedInHistoryMessage): string {
  return row.subject ? `${row.subject}\n${row.text ?? ""}`.trim() : (row.text ?? "");
}

/**
 * A mirrored row as a {@link ChannelMessage}.
 *
 * A group once LinkedIn has said so, and otherwise a direct thread, the way the
 * channel's history has always read it: the mirror knows a thread is a group
 * only once it has been snapshotted. The mirror keeps no attachments.
 */
export function linkedInHistoryMessage(row: LinkedInHistoryMessage): ChannelMessage {
  return {
    channel: "linkedin",
    direction: row.senderIsSelf ? "outbound" : "inbound",
    messageId: row.messageId,
    conversationId: row.threadId as ConversationId,
    senderId: linkedInChannelUserId(row),
    senderDisplayName: row.senderName ?? "",
    text: linkedInHistoryText(row),
    attachments: [],
    timestamp: row.sentAt,
    thread: {
      kind: row.isGroup === true ? "group" : "dm",
      ...(row.threadName ? { name: row.threadName } : {}),
    },
    raw: row,
  };
}
