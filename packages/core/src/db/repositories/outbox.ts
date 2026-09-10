import { and, eq, gt, inArray, lt, lte, or, type SQL } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { SEND_IDEMPOTENCY_RETENTION_MS, type OutboxMessage } from "@rome/api-types/people";
import { outboundMessages, outboundSendReceipts } from "../schema.js";
import type { DrizzleDb, DrizzleTx } from "../index.js";

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
  /** When the row last changed state. A retry moves this and not `createdAt`,
   *  so "how long has this been in flight" is asked of the attempt rather than
   *  of the first one. */
  updatedAt: Date;
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
    const claimed = await this.openOnce({ ...input, id: uuid() });
    if (!claimed.created) throw new Error("Generated send id already exists");
    return claimed.row;
  }

  /** Only a new claim may call the provider. Active rows and unexpired receipts
   * both own their ids, including across concurrent cleanup and send requests. */
  async openOnce(input: {
    id: string;
    channel: string;
    channelUserId: string;
    conversationId: string;
    text: string;
  }): Promise<{ row: OutboxRow; created: true } | { message: OutboxMessage; created: false }> {
    const now = new Date();
    const row = {
      ...input,
      state: "sending" as const,
      providerMessageId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    // The write lock covers both stores: cleanup cannot retire a row between
    // checking its receipt and claiming the id in the outbox.
    return this.db.transaction(
      (tx) => {
        tx.delete(outboundSendReceipts).where(lte(outboundSendReceipts.expiresAt, now)).run();
        const existing = this.recordedSend(tx, input.id, now);
        if (existing) return { message: existing, created: false as const };
        tx.insert(outboundMessages).values(row).run();
        return { row, created: true as const };
      },
      { behavior: "immediate" },
    );
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

  /**
   * Put a failed row back in flight, under its own id, so a retry does not read
   * as a second message the guardian never wrote.
   *
   * The claim is the update itself, not a check before it. Reading the state
   * and then writing lets two retries of one row both pass the read and both
   * reach the provider — a double-clicked button delivering the message twice,
   * which is the harm this whole surface is arranged to avoid. Guarding on
   * `failed` and answering off the affected count makes exactly one of them
   * win, and the loser sees a row that is no longer theirs to send.
   */
  async reopen(id: string): Promise<OutboxRow | null> {
    const updatedAt = new Date();
    const claimed = await this.db
      .update(outboundMessages)
      .set({ state: "sending", error: null, providerMessageId: null, updatedAt })
      .where(and(eq(outboundMessages.id, id), eq(outboundMessages.state, "failed")));
    if (claimed.changes === 0) return null;

    const row = await this.find(id);
    return row === null ? null : { ...row, updatedAt };
  }

  /**
   * Give up on a send, and answer whether there was one to give up on.
   *
   * A row is dismissable once nothing is going to happen to it on its own. A
   * `failed` one is finished. An `unconfirmed` one that has outlived the window
   * a message lands in was delivered and will never be seen — on a channel with
   * no mirror, one whose transcript write failed has no other way out, and
   * leaving it would be a phantom the guardian can neither retry nor dismiss.
   *
   * Everything else is refused. A send whose provider call is still outstanding
   * has no known outcome, and one that has just been accepted is about to clear
   * itself; dismissing either loses the record of a message already on its way.
   *
   * Both conditions ride in the WHERE clause rather than a read before it. A
   * discard racing a retry could otherwise pass its check, have the retry claim
   * and deliver the row in between, and delete it a moment later — a message
   * sent with no record of it, which is the thing this table exists to prevent.
   */
  async discard(id: string, settledBefore: Date): Promise<boolean> {
    return this.retire(
      id,
      or(
        eq(outboundMessages.state, "failed"),
        and(
          eq(outboundMessages.state, "unconfirmed"),
          lt(outboundMessages.updatedAt, settledBefore),
        ),
      ),
    );
  }

  /** A send whose process died before the channel answered, marked so it can
   *  be seen and retried. Rome cannot know whether it went out, and the error
   *  says exactly that rather than guessing either way. */
  async stranded(id: string, error: string): Promise<void> {
    await this.db
      .update(outboundMessages)
      .set({ state: "failed", error, updatedAt: new Date() })
      .where(and(eq(outboundMessages.id, id), eq(outboundMessages.state, "sending")));
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
    this.retire(id);
  }

  /** A replayable response, even after delivery cleanup or discard. */
  async findSend(id: string): Promise<OutboxMessage | null> {
    return this.recordedSend(this.db, id, new Date());
  }

  private recordedSend(db: DrizzleDb | DrizzleTx, id: string, now: Date): OutboxMessage | null {
    const active = db.select().from(outboundMessages).where(eq(outboundMessages.id, id)).get();
    if (active) return outboxMessage(active);
    const receipt = db
      .select()
      .from(outboundSendReceipts)
      .where(and(eq(outboundSendReceipts.id, id), gt(outboundSendReceipts.expiresAt, now)))
      .get();
    return receipt?.response ?? null;
  }

  private retire(id: string, condition?: SQL): boolean {
    const now = new Date();
    // The response and deletion commit together. A crash or another connection
    // can observe the active row or its receipt, never an unclaimed id.
    return this.db.transaction(
      (tx) => {
        const row = tx
          .delete(outboundMessages)
          .where(and(eq(outboundMessages.id, id), condition))
          .returning()
          .get();
        if (!row) return false;
        tx.delete(outboundSendReceipts).where(lte(outboundSendReceipts.expiresAt, now)).run();
        tx.insert(outboundSendReceipts)
          .values({
            id: row.id,
            response: outboxMessage(row),
            expiresAt: new Date(now.getTime() + SEND_IDEMPOTENCY_RETENTION_MS),
          })
          .run();
        return true;
      },
      { behavior: "immediate" },
    );
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

export function outboxMessage(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    channel: row.channel,
    channelUserId: row.channelUserId,
    text: row.text,
    timestamp: Math.floor(row.createdAt.getTime() / 1000),
    state: row.state,
    ref: row.providerMessageId ? `${row.conversationId}:${row.providerMessageId}` : null,
    error: row.error,
  };
}
