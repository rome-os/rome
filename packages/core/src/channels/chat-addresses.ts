// The channels layer's one address store, shared by every adapter. Contract:
// docs/architecture/channels.md#chat-adapters.
//
// A chat's key is its address on most platforms. Where it is not, as for a
// direct message a platform gives an id of its own (Feishu's p2p chat,
// Discord's DM channel), the adapter keeps the address here, by Rome's
// account and the chat's key, when it first hears the chat there. Chats never
// reads it.

import type { Account } from "@rome-os/app-runtime";
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { channelAddresses } from "../db/schema/system.js";

export class ChatAddresses {
  constructor(private readonly db: DrizzleDb) {}

  /** Note that `account` reaches the chat it keys `chatKey` at `address`.
   *  The latest address it heard the chat at wins. */
  bind(account: Account, chatKey: string, address: string): void {
    this.db
      .insert(channelAddresses)
      .values({ platform: account.platform, accountId: account.id, chatKey, address })
      .onConflictDoUpdate({
        target: [channelAddresses.platform, channelAddresses.accountId, channelAddresses.chatKey],
        set: { address },
      })
      .run();
  }

  /** Where `account` reaches the chat it keys `chatKey`, or null when it
   *  has not heard it anywhere but its key. */
  addressOf(account: Account, chatKey: string): string | null {
    return (
      this.db
        .select({ address: channelAddresses.address })
        .from(channelAddresses)
        .where(
          and(
            eq(channelAddresses.platform, account.platform),
            eq(channelAddresses.accountId, account.id),
            eq(channelAddresses.chatKey, chatKey),
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
        .select({ chatKey: channelAddresses.chatKey })
        .from(channelAddresses)
        .where(
          and(
            eq(channelAddresses.platform, account.platform),
            eq(channelAddresses.accountId, account.id),
            eq(channelAddresses.address, address),
          ),
        )
        .get()?.chatKey ?? null
    );
  }
}
