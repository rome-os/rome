/**
 * Contract between the WhatsApp adapter (the producer of Baileys sync events)
 * and whatever persists them. The adapter translates Baileys' `Contact` /
 * `Chat` / `WAMessage` shapes into these plain DTOs and hands them to a
 * `WhatsAppSyncSink`; `WhatsAppStoreRepository` is the production sink, and
 * tests pass a fake. Keeping the contract here (not in the db layer) lets the
 * adapter stay free of any database dependency and makes its unit tests trivial.
 */

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
}
