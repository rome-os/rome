// A row of the WhatsApp mirror as the message it records, for the channel's
// `query` and its account reads (whatsapp-messages.ts).

import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import type { Attachment } from "./types.js";
import type { WaHistoryMessage } from "./whatsapp-sync.js";

/** The line a mirrored row reads as. A reaction names what it reacted to, and
 *  media with no caption reads as its type rather than as nothing. */
function historyText(row: WaHistoryMessage): string {
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
function historyAttachments(row: WaHistoryMessage): Attachment[] {
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

/** The sender id of a group line the mirror recorded no address for. The
 *  chat's JID names the group, not whoever spoke in it. */
export const WHATSAPP_UNKNOWN_SENDER = "whatsapp:unknown";

/**
 * A mirrored row as a {@link ChannelMessage}.
 *
 * The sender is named by what the mirror recorded for them — the contact's
 * name, the name they set on WhatsApp, or their number — and left unnamed
 * otherwise. A caller that has to show a line from an unnamed sender picks its
 * own fallback.
 */
export function whatsAppHistoryMessage(row: WaHistoryMessage): ChannelMessage {
  const isGroup = row.isGroup || row.chatJid.endsWith("@g.us");
  const senderId = row.fromMe
    ? (row.senderJid ?? WHATSAPP_SELF_SENDER)
    : isGroup
      ? (row.senderJid ?? WHATSAPP_UNKNOWN_SENDER)
      : row.chatJid;
  const threadName = row.chatName ?? row.chatPhoneNumber ?? undefined;
  const senderName = row.senderName ?? row.pushName ?? row.senderPhoneNumber;
  return {
    channel: "whatsapp",
    direction: row.fromMe ? "outbound" : "inbound",
    messageId: row.id,
    conversationId: row.chatJid as ConversationId,
    senderId,
    ...(senderName ? { senderDisplayName: senderName } : {}),
    text: historyText(row),
    attachments: historyAttachments(row),
    timestamp: row.timestamp,
    thread: { kind: isGroup ? "group" : "dm", ...(threadName ? { name: threadName } : {}) },
    raw: row,
  };
}
