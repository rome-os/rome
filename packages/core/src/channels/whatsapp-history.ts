// A row of the WhatsApp mirror as the message it records, for the channel's
// `query` (whatsapp-messages.ts). The adapter's history read shares the line and
// the attachments, but still names the sender and the chat through its live
// connection until that read is removed.

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

/** The sender id of a line the guardian sent, when the mirror recorded no
 *  address for it. The sync leaves a direct chat's outbound sender empty, and
 *  the chat's own JID names the other person. */
export const WHATSAPP_SELF_SENDER = "whatsapp:self";

/**
 * A mirrored row as a {@link ChannelMessage}.
 *
 * The guardian's own lines are named "You", the name the channel's history has
 * always given them.
 */
export function whatsAppHistoryMessage(row: WaHistoryMessage): ChannelMessage {
  const isGroup = row.isGroup || row.chatJid.endsWith("@g.us");
  const senderId = row.fromMe
    ? (row.senderJid ?? WHATSAPP_SELF_SENDER)
    : isGroup
      ? (row.senderJid ?? row.chatJid)
      : row.chatJid;
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
