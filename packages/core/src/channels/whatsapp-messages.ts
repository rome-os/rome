import { isJidGroup, jidNormalizedUser } from "@whiskeysockets/baileys";
import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { WhatsAppStoreRepository } from "../db/repositories/whatsapp-store.js";
import { queryLimit, type Messages } from "./messages.js";
import { inList, keysIn, sqlMessages } from "./messages-sql.js";
import { whatsAppHistoryMessage } from "./whatsapp-history.js";

/**
 * `Messages` over the WhatsApp message mirror (`wa_messages`) — the thread as
 * the channel has it, which is the fullest record of a WhatsApp conversation
 * Rome holds.
 *
 * `query` reads every chat, groups and reactions included, with the chat's and
 * the sender's names joined from the mirror's contacts and chats.
 *
 * The account reads are scoped by chat. A WhatsApp message hangs off the chat
 * it was said in, and a direct chat is addressed by the contact. A contact
 * reachable both as a phone JID and as a `@lid` JID has a chat under each, and
 * `WhatsAppAccounts` folds both onto one account — so a caller that passes the
 * account's addresses reads one history rather than whichever half its person
 * mapping happened to name. Two things the mirror holds are left out of them:
 *
 * - Group chats (`@g.us`). A group is addressed by the group rather than by
 *   anyone on it, so no address of an account names one — the `NOT LIKE` is
 *   belt and braces against a group JID arriving as an address.
 * - Reactions. A reaction answers a line rather than being one, and the address
 *   book's own activity already leaves it out of what an account last did.
 *   Carrying it here would let a directory row preview a thumbs-up and open on
 *   the message it was aimed at.
 */
export function whatsAppMessages(db: DrizzleDb): Messages {
  const mirror = new WhatsAppStoreRepository(db);
  return {
    async query({ conversationId, since, limit }) {
      const chat = conversationId ? canonicalChat(conversationId) : null;
      const rows = await mirror.fetchHistory(chat, since ?? new Date(0));
      // The mirror answers oldest first; the port answers newest first.
      return rows.reverse().slice(0, queryLimit(limit)).map(whatsAppHistoryMessage);
    },
    byAccount: sqlMessages({
      channel: "whatsapp",
      db,
      view(scope) {
        const chats = inList(sql`m.chat_jid`, keysIn(scope.keys));
        if (chats === null) return null;
        return sql`
          SELECT
            'whatsapp' AS source,
            m.chat_jid AS key,
            m.timestamp AS at,
            CASE WHEN m.from_me THEN 1 ELSE 0 END AS outbound,
            m.chat_jid || ':' || m.id AS ref,
            m.text AS body,
            coalesce(m.sender_jid, CASE WHEN m.from_me THEN NULL ELSE m.chat_jid END) AS sender_id,
            CASE WHEN m.from_me THEN NULL
              ELSE coalesce(sc.name, sc.notify, sc.verified_name, m.push_name,
                            cc.name, cc.notify, cc.verified_name)
            END AS sender_name,
            m.chat_jid AS conversation_id,
            coalesce(ch.name, cc.name, cc.notify, cc.verified_name, cc.phone_number)
              AS conversation_name,
            'dm' AS conversation_kind,
            CASE WHEN m.has_media AND m.type IN ('image', 'video', 'audio', 'document', 'sticker')
              THEN m.type END AS attachment_type
          FROM wa_messages m
          LEFT JOIN wa_chats ch ON ch.jid = m.chat_jid
          LEFT JOIN wa_contacts cc ON cc.jid = m.chat_jid
          LEFT JOIN wa_contacts sc ON sc.jid = m.sender_jid
          WHERE ${chats}
            AND m.chat_jid NOT LIKE '%@g.us'
            AND coalesce(m.type, '') <> 'reaction'`;
      },
    }),
  };
}

/** A chat as the mirror keys it: a user JID with its device suffix dropped, the
 *  way the sync writes it. A group JID is already its own key. */
function canonicalChat(jid: string): string {
  return isJidGroup(jid) ? jid : jidNormalizedUser(jid);
}
