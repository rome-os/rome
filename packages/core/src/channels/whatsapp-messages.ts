import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { Messages } from "./messages.js";
import { inList, keysIn, sqlMessages } from "./messages-sql.js";

/**
 * `Messages` over the WhatsApp message mirror (`wa_messages`) — the thread as
 * the channel has it, which is the fullest record of a WhatsApp conversation
 * Rome holds.
 *
 * Scoped by chat either way it is asked. A WhatsApp message hangs off the chat
 * it was said in, a direct chat is addressed by the contact, and a chat's JID
 * is what WhatsApp calls the conversation — so an account's addresses and a
 * conversation's id select on the same column, and the scopes differ only in
 * what they subtract. A contact reachable both as a phone JID and as a `@lid`
 * JID has a chat under each, and `WhatsAppAccounts` folds both onto one account
 * — so a caller that passes the account's addresses reads one history rather
 * than whichever half its person mapping happened to name.
 *
 * Two things the mirror holds are left out:
 *
 * - Group chats (`@g.us`), from the account reads. A group is addressed by the
 *   group rather than by anyone on it, so no address of an account names one —
 *   the `NOT LIKE` is belt and braces against a group JID arriving as an
 *   address. A conversation read names the group itself and answers it.
 * - Reactions, from every read. A reaction answers a line rather than being
 *   one, and the address book's own activity already leaves it out of what an
 *   account last did. Carrying it here would let a directory row preview a
 *   thumbs-up and open on the message it was aimed at, and would put one in a
 *   conversation between the lines it was aimed at.
 */
export function whatsAppMessages(db: DrizzleDb): Messages {
  return sqlMessages({
    channel: "whatsapp",
    db,
    view(scope) {
      const chats = inList(sql`m.chat_jid`, keysIn(scope.keys));
      if (chats === null) return null;
      const held = scope.by === "account" ? sql`${chats} AND m.chat_jid NOT LIKE '%@g.us'` : chats;
      return sql`
        SELECT
          'whatsapp' AS source,
          m.chat_jid AS key,
          m.timestamp AS at,
          CASE WHEN m.from_me THEN 1 ELSE 0 END AS outbound,
          m.chat_jid || ':' || m.id AS ref,
          m.text AS body
        FROM wa_messages m
        WHERE ${held}
          AND coalesce(m.type, '') <> 'reaction'`;
    },
  });
}
