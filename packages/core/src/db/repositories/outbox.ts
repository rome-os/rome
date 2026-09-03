import { and, eq, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { outboundMessages } from "../schema.js";
import type { DrizzleDb } from "../index.js";

/**
 * The outbox: messages Rome has been asked to send and has not yet seen land.
 *
 * Rows are addressed by account, not by person. A send names an account and a
 * merge moves a link, so a row keyed by the person it was addressed to would
 * point at the wrong one afterwards; keyed by the address it stays true.
 *
 * Nothing here decides when a row is done. That is a question about the
 * timeline — has this message shown up in the store the timeline reads — and it
 * is answered where both are in hand (`src/people/outbox.ts`).
 */

export interface OutboxRow {
  id: string;
  channel: string;
  channelUserId: string;
  conversationId: string;
  text: string;
  state: "sending" | "unconfirmed" | "failed";
  providerMessageId: string | null;
  error: string | null;
  createdAt: Date;
}

export interface OutboxAccount {
  channel: string;
  channelUserId: string;
}

export class OutboxRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** Record the attempt before it is made, so a process that dies mid-send
   *  leaves evidence rather than silence. */
  async open(input: {
    channel: string;
    channelUserId: string;
    conversationId: string;
    text: string;
  }): Promise<OutboxRow> {
    const now = new Date();
    const row = {
      id: uuid(),
      ...input,
      state: "sending" as const,
      providerMessageId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(outboundMessages).values(row);
    return row;
  }

  /** The channel took it and named it. Not "delivered" — that is decided by
   *  the message appearing on the timeline, not by this answer. */
  async accepted(id: string, providerMessageId: string | null): Promise<void> {
    await this.db
      .update(outboundMessages)
      .set({ state: "unconfirmed", providerMessageId, error: null, updatedAt: new Date() })
      .where(eq(outboundMessages.id, id));
  }

  async refused(id: string, error: string): Promise<void> {
    await this.db
      .update(outboundMessages)
      .set({ state: "failed", error, updatedAt: new Date() })
      .where(eq(outboundMessages.id, id));
  }

  /** Put a failed row back in flight, under its own id, so a retry does not
   *  read as a second message the guardian never wrote. */
  async reopen(id: string): Promise<OutboxRow | null> {
    const row = await this.find(id);
    if (row === null || row.state !== "failed") return null;
    await this.db
      .update(outboundMessages)
      .set({ state: "sending", error: null, providerMessageId: null, updatedAt: new Date() })
      .where(eq(outboundMessages.id, id));
    return { ...row, state: "sending", error: null, providerMessageId: null };
  }

  async find(id: string): Promise<OutboxRow | null> {
    const [row] = await this.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, id))
      .limit(1);
    return row ?? null;
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(outboundMessages).where(eq(outboundMessages.id, id));
  }

  /** Every open row for a set of accounts, oldest first — the order they were
   *  written in, which is the order they were meant to arrive in. */
  async forAccounts(accounts: readonly OutboxAccount[]): Promise<OutboxRow[]> {
    if (accounts.length === 0) return [];
    const channels = [...new Set(accounts.map((a) => a.channel))];
    const addresses = [...new Set(accounts.map((a) => a.channelUserId))];
    // Narrowed by the index and then filtered exactly: the two `IN`s together
    // admit pairs nobody asked for when a person holds several accounts.
    const rows = await this.db
      .select()
      .from(outboundMessages)
      .where(
        and(
          inArray(outboundMessages.channel, channels),
          inArray(outboundMessages.channelUserId, addresses),
        ),
      );
    const wanted = new Set(accounts.map((a) => `${a.channel}\n${a.channelUserId}`));
    return rows
      .filter((row) => wanted.has(`${row.channel}\n${row.channelUserId}`))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}
