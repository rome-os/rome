// The adapters' one address store, shared by every adapter. Contract:
// docs/architecture/channels.md#adapter-keys.
//
// A chat's key is its address on most platforms. Where it is not, as for a
// direct message a platform gives an id of its own (Feishu's p2p chat,
// Discord's DM channel), the adapter keeps the address here, by Rome's
// account and the chat's key, when it first hears the chat there. A thread's
// address is kept the same way, under its chat's key and the thread, so a
// send that names only the thread finds its chat. Chats never reads it, and
// no adapter writes it yet.

import type { Account } from "@rome-os/app-runtime";
import { and, eq, ne, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { chatAddresses, chats } from "../db/schema/system.js";

/** The thread a chat's own address is kept under. */
const CHAT = "";

export class ChatAddresses {
  constructor(private readonly db: DrizzleDb) {}

  /** Note that `account` reaches the chat it keys `chatKey` at `address`.
   *  The latest address it heard the chat at wins. */
  bind(account: Account, chatKey: string, address: string): void {
    this.db
      .insert(chatAddresses)
      .values({ platform: account.platform, accountId: account.id, chatKey, address })
      .onConflictDoUpdate({
        target: [
          chatAddresses.platform,
          chatAddresses.accountId,
          chatAddresses.chatKey,
          chatAddresses.threadId,
        ],
        set: { address },
      })
      .run();
  }

  /** Where `account` reaches the chat it keys `chatKey`, or null when it
   *  has not heard it anywhere but its key. */
  addressOf(account: Account, chatKey: string): string | null {
    return (
      this.db
        .select({ address: chatAddresses.address })
        .from(chatAddresses)
        .where(
          and(
            eq(chatAddresses.platform, account.platform),
            eq(chatAddresses.accountId, account.id),
            eq(chatAddresses.chatKey, chatKey),
            eq(chatAddresses.threadId, CHAT),
          ),
        )
        .get()?.address ?? null
    );
  }

  /**
   * Key the chat keyed `from` on `account`'s platform `to` instead, with
   * every address kept for it: a direct message Rome reached at its address
   * before it knew the other end, once it does, or one Rome took for a
   * direct message once a group message is heard there, which also names it
   * `kind`. Where a chat already holds `to`, as when another of Rome's
   * accounts heard the group first, the chat keyed `from` joins it: its
   * messages, its speakers and their turns' links move there, and a message
   * both hold is kept once, as the one the chat keyed `to` holds.
   */
  rekey(account: Account, from: string, to: string, kind?: "group" | "dm"): void {
    // The write lock is taken before the reads: another connection's
    // write between a read and the first write here would fail the rekey.
    this.db.transaction(
      (tx) => {
        const keyed = (key: string) =>
          tx
            .select({ id: chats.id })
            .from(chats)
            .where(and(eq(chats.platform, account.platform), eq(chats.key, key)))
            .get()?.id;
        const taken = keyed(to);
        const moving = keyed(from);
        if (taken === undefined) {
          tx.update(chats)
            .set({ key: to, ...(kind ? { kind } : {}) })
            .where(and(eq(chats.platform, account.platform), eq(chats.key, from)))
            .run();
        } else if (moving !== undefined) {
          joinChat(tx, moving, taken);
          if (kind) tx.update(chats).set({ kind }).where(eq(chats.id, taken)).run();
        }
        tx.run(sql`
        UPDATE OR REPLACE chat_addresses SET chat_key = ${to}
        WHERE platform = ${account.platform} AND chat_key = ${from}
      `);
      },
      { behavior: "immediate" },
    );
  }

  /** The key of the chat `account` reaches at `address`, or null when it
   *  heard none there. */
  keyAt(account: Account, address: string): string | null {
    return (
      this.db
        .select({ chatKey: chatAddresses.chatKey })
        .from(chatAddresses)
        .where(
          and(
            eq(chatAddresses.platform, account.platform),
            eq(chatAddresses.accountId, account.id),
            eq(chatAddresses.address, address),
            eq(chatAddresses.threadId, CHAT),
          ),
        )
        .get()?.chatKey ?? null
    );
  }

  /** Note that `account` reaches thread `threadId` of the chat it keys
   *  `chatKey` at the thread's own id, as a platform whose threads are
   *  addressed by their id reaches them. */
  bindThread(account: Account, threadId: string, chatKey: string): void {
    this.db
      .insert(chatAddresses)
      .values({
        platform: account.platform,
        accountId: account.id,
        chatKey,
        threadId,
        address: threadId,
      })
      .onConflictDoNothing()
      .run();
  }

  /** The key of the chat whose thread `account` reaches at `address`, or
   *  null when it heard no thread there. */
  threadChatAt(account: Account, address: string): string | null {
    return (
      this.db
        .select({ chatKey: chatAddresses.chatKey })
        .from(chatAddresses)
        .where(
          and(
            eq(chatAddresses.platform, account.platform),
            eq(chatAddresses.accountId, account.id),
            eq(chatAddresses.address, address),
            ne(chatAddresses.threadId, CHAT),
          ),
        )
        .get()?.chatKey ?? null
    );
  }
}

/** Move every message and speaker of chat `from` into chat `into`, and
 *  delete `from`. A message `into` already holds by its key stays once, as
 *  `into`'s, and whatever named the other copy names it. */
function joinChat(tx: DrizzleTx, from: number, into: number): void {
  // Each message both chats hold, by its id in each.
  tx.run(sql`
    CREATE TEMP TABLE IF NOT EXISTS joined_chat_messages (
      from_id integer PRIMARY KEY NOT NULL,
      into_id integer NOT NULL
    )
  `);
  tx.run(sql`DELETE FROM joined_chat_messages`);
  tx.run(sql`
    INSERT INTO joined_chat_messages (from_id, into_id)
    SELECT f.id, i.id FROM chat_messages f
    JOIN chat_messages i ON i.chat_id = ${into} AND i.key = f.key
    WHERE f.chat_id = ${from}
  `);
  // Where only the moving copy knows Rome said it, as when the other account
  // heard Rome's send as an echo, the kept copy takes the message as Rome
  // said it, as a send that finds its echo on record does. A quote it takes
  // names the moving chat's copy until quotes move below.
  tx.run(sql`
    UPDATE chat_messages AS i
    SET sender_account_id = f.sender_account_id,
        sender_agent = f.sender_agent,
        sender_name = f.sender_name,
        text = f.text,
        parts = f.parts,
        reply_to_message_id = coalesce(f.reply_to_message_id, i.reply_to_message_id)
    FROM joined_chat_messages j JOIN chat_messages f ON f.id = j.from_id
    WHERE j.into_id = i.id AND i.sender_agent IS NULL AND f.sender_agent IS NOT NULL
  `);
  tx.run(sql`
    UPDATE OR IGNORE agent_turn_messages
    SET message_id = (SELECT j.into_id FROM joined_chat_messages j WHERE j.from_id = message_id)
    WHERE message_id IN (SELECT from_id FROM joined_chat_messages)
  `);
  tx.run(sql`
    UPDATE chat_messages
    SET reply_to_message_id = (
      SELECT j.into_id FROM joined_chat_messages j WHERE j.from_id = reply_to_message_id)
    WHERE reply_to_message_id IN (SELECT from_id FROM joined_chat_messages)
  `);
  tx.run(sql`
    UPDATE concierge_tasks
    SET source_message_id = (
      SELECT j.into_id FROM joined_chat_messages j WHERE j.from_id = source_message_id)
    WHERE source_message_id IN (SELECT from_id FROM joined_chat_messages)
  `);
  // A link the copy kept already stood on the message; it goes with the copy.
  tx.run(sql`DELETE FROM chat_messages WHERE id IN (SELECT from_id FROM joined_chat_messages)`);
  tx.run(sql`DELETE FROM joined_chat_messages`);
  tx.run(sql`UPDATE chat_messages SET chat_id = ${into} WHERE chat_id = ${from}`);
  tx.run(sql`UPDATE rome_sessions SET chat_id = ${into} WHERE chat_id = ${from}`);
  tx.run(sql`DELETE FROM chats WHERE id = ${from}`);
}
