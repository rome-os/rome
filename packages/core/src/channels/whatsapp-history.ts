// A row of the WhatsApp mirror as the message it records. Shared by the
// channel's `query` (whatsapp-messages.ts) and the adapter's history read, so
// the two cannot render one row two ways.

import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import type { Attachment } from "./types.js";
import type { WaHistoryMessage } from "./whatsapp-sync.js";

/** The line a mirrored row reads as. A reaction names what it reacted to, and
 *  media with no caption reads as its type rather than as nothing. */
export function historyText(row: WaHistoryMessage): string {
  if (row.type === "reaction") {
    const emoji = row.text?.trim() || "reaction";
    return row.reactsToId ? `Reacted ${emoji} to message ${row.reactsToId}` : `Reacted ${emoji}`;
  }
  const text = row.text?.trim() ?? "";
  if (text) return text;
  if (row.hasMedia) {
    return `[${row.type ?? "media"}]`;
  }
  return "";
}

/** What came attached to a mirrored row, as far as the mirror knows it: the
 *  kind, and the caption the text doubles as. The mirror keeps no file name,
 *  MIME type or download handle. */
export function historyAttachments(row: WaHistoryMessage): Attachment[] {
  if (!row.hasMedia) return [];
  const type = historyAttachmentType(row.type);
  if (!type) return [];
  const text = row.text?.trim();
  return [
    {
      type,
      ...(text ? { caption: text } : {}),
    },
  ];
}

function historyAttachmentType(type: string | null): Attachment["type"] | null {
  switch (type) {
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return type;
    default:
      return null;
  }
}

/**
 * A mirrored row as a {@link ChannelMessage}.
 *
 * The guardian's own lines are named "You", the name the channel's history has
 * always given them. The mirror does not record the guardian's own address, so
 * their sender id is the address the row names, or the chat's.
 */
export function whatsAppHistoryMessage(row: WaHistoryMessage): ChannelMessage {
  const isGroup = row.isGroup || row.chatJid.endsWith("@g.us");
  const senderId = row.fromMe || isGroup ? (row.senderJid ?? row.chatJid) : row.chatJid;
  const threadName = row.chatName ?? row.chatPhoneNumber ?? undefined;
  return {
    channel: "whatsapp",
    direction: row.fromMe ? "outbound" : "inbound",
    messageId: row.id,
    conversationId: row.chatJid as ConversationId,
    senderId,
    senderDisplayName: row.fromMe
      ? "You"
      : (row.senderName ?? row.pushName ?? row.senderPhoneNumber ?? row.senderJid ?? "Unknown"),
    text: historyText(row),
    attachments: historyAttachments(row),
    timestamp: row.timestamp,
    thread: { kind: isGroup ? "group" : "dm", ...(threadName ? { name: threadName } : {}) },
    raw: row,
  };
}
