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
import { and, eq, ne } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { chatAddresses } from "../db/schema/system.js";

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
