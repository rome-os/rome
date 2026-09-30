import { isJidGroup, jidNormalizedUser } from "@whiskeysockets/baileys";
import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import {
  WA_HISTORY_JOINS,
  WhatsAppStoreRepository,
  waHistoryJson,
  waHistoryRow,
} from "../db/repositories/whatsapp-store.js";
import { channelMessageDetail, queryLimit, querySince, type Messages } from "./messages.js";
import { inList, keysIn, sqlMessages } from "./messages-sql.js";
import { whatsAppHistoryMessage } from "./whatsapp-history.js";

/**
 * `Messages` over the WhatsApp message mirror (`wa_messages`) — the thread as
 * the channel has it, which is the fullest record of a WhatsApp conversation
 * Rome holds.
 *
 * `query` reads every chat, groups and reactions included, with the chat's and
 * the sender's names joined from the mirror's contacts and chats. The account
 * reads describe a message through the same row mapper, so a line reads the
 * same sender, chat and attachments through either.
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
      const rows = await mirror.fetchHistory(chat, querySince(since), queryLimit(limit));
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
            ${waHistoryJson()} AS detail
          FROM wa_messages m
          ${WA_HISTORY_JOINS}
          WHERE ${chats}
            AND m.chat_jid NOT LIKE '%@g.us'
            AND coalesce(m.type, '') <> 'reaction'`;
      },
      detail: (raw) => channelMessageDetail(whatsAppHistoryMessage(waHistoryRow(raw))),
    }),
  };
}

/** A chat as the mirror keys it: a user JID with its device suffix dropped, the
 *  way the sync writes it. A group JID is already its own key. The sync also
 *  folds the guardian's own `@lid` onto their phone JID, which takes the live
 *  connection, so a chat with yourself is found by the phone JID only. */
function canonicalChat(jid: string): string {
  return isJidGroup(jid) ? jid : jidNormalizedUser(jid);
}
