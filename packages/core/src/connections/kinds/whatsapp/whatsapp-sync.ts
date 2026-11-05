/**
 * Contract between the WhatsApp adapter (the producer of Baileys sync events)
 * and whatever persists them. The adapter translates Baileys' `Contact` /
 * `Chat` / `WAMessage` shapes into these plain DTOs and hands them to a
 * `WhatsAppSyncSink`; `WhatsAppStoreRepository` is the production sink, and
 * tests pass a fake. Keeping the contract here (not in the db layer) lets the
 * adapter stay free of any database dependency and makes its unit tests trivial.
 */

import type { Attachment } from "@rome-os/app-runtime";
import type { SyncedMessage } from "../../history-recording.js";

export interface WaContactInput {
  /** Contact JID — `@s.whatsapp.net` or `@lid` form, as Baileys reports it. */
  jid: string;
  phoneNumber?: string | null;
  /** Name saved in the guardian's address book. */
  name?: string | null;
  /** Name the contact set for themselves (push name). */
  notify?: string | null;
  verifiedName?: string | null;
  imgUrl?: string | null;
}

export interface WaChatInput {
  jid: string;
  name?: string | null;
  isGroup: boolean;
  lastMessageAt?: Date | null;
  unreadCount?: number | null;
  archived?: boolean | null;
}

export interface WaMessageInput {
  id: string;
  chatJid: string;
  senderJid?: string | null;
  fromMe: boolean;
  timestamp: Date;
  type?: string | null;
  text?: string | null;
  hasMedia: boolean;
  pushName?: string | null;
  /**
   * For a reaction (`type === "reaction"`), the id of the message it reacts to;
   * `text` carries the emoji. Null for every other message type.
   */
  reactsToId?: string | null;
}

export interface WaHistoryMessage {
  id: string;
  chatJid: string;
  chatName: string | null;
  chatPhoneNumber: string | null;
  isGroup: boolean;
  senderJid: string | null;
  senderName: string | null;
  senderPhoneNumber: string | null;
  fromMe: boolean;
  timestamp: Date;
  type: string | null;
  text: string | null;
  hasMedia: boolean;
  pushName: string | null;
  reactsToId: string | null;
}

export interface WhatsAppSyncSink {
  upsertContacts(contacts: WaContactInput[]): Promise<void>;
  upsertChats(chats: WaChatInput[]): Promise<void>;
  upsertMessages(messages: WaMessageInput[]): Promise<void>;
  /**
   * Record in Chats the messages Rome's account `self` did not hear as they
   * arrived: a history sync's, and the ones the guardian said on the account
   * themselves. The adapter never hands over a message it also delivers
   * inbound, so recording one here never takes its place.
   */
  recordHistory?(messages: WaMessageInput[], self: string): void;
}

/**
 * A synced WhatsApp message as Chats records it, for Rome's account `self`, or
 * null for one Chats does not record. A reaction answers a message rather than
 * being one, so it is left out. Media reads as its kind, with any caption, since
 * the sync keeps no file.
 */
export function syncedFromWhatsApp(message: WaMessageInput, self: string): SyncedMessage | null {
  if (message.type === "reaction") return null;
  const group = message.chatJid.endsWith("@g.us");
  const senderId = message.fromMe ? self : (message.senderJid ?? message.chatJid);
  const type = attachmentType(message.type);
  const caption = message.text?.trim();
  const attachments: Attachment[] =
    message.hasMedia && type ? [{ type, ...(caption ? { caption } : {}) }] : [];
  return {
    address: message.chatJid,
    kind: group ? "group" : "dm",
    id: message.id,
    sender: {
      id: senderId,
      ...(!message.fromMe && message.pushName ? { name: message.pushName } : {}),
    },
    // A media message's text is its caption, which its attachment carries.
    text: attachments.length > 0 ? "" : (message.text ?? ""),
    attachments,
    at: message.timestamp,
  };
}

function attachmentType(type: string | null | undefined): Attachment["type"] | null {
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
