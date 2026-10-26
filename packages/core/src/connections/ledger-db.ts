// Drizzle-backed grant ledger. Vocabulary: docs/domains/connections.md.
// Persists connections and grants into the `connections` / `connection_grants` tables. The registry
// contract suites (registry-*.test.ts) run against this implementation.
//
// The `credential` column stores a PersistedCredential envelope as plain JSON
// (encryption was deliberately dropped). The envelope shape is kept so
// encryption can return later. The runtime never reads inside `material`.

import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx, SqliteExec } from "../db/index.js";
import { connectionGrants, connections } from "../db/schema/system.js";
import type { ConnectionId, ProfileRecord } from "./types.js";
import {
  type ConnectionRecord,
  type GrantAccount,
  type GrantLedger,
  type GrantRecord,
  type GrantValue,
  grantValueOf,
  type PersistedCredential,
} from "./ledger.js";

type GrantRow = typeof connectionGrants.$inferSelect;

/** Revive a JSON-decoded PersistedCredential. The `credential` column is stored
 *  as plain JSON, so `expiresAt` comes back as an ISO string (or "never") rather
 *  than a Date — reconstitute it so the runtime sees the same shape the in-memory
 *  ledger returns (the runtime only reads the envelope). */
function reviveCredential(raw: unknown): PersistedCredential {
  const persisted = raw as PersistedCredential;
  const expiresAt =
    persisted.expiresAt === "never" ? "never" : new Date(persisted.expiresAt as unknown as string);
  return { material: persisted.material, expiresAt };
}

function rowToGrant(row: GrantRow): GrantRecord {
  const rec: GrantRecord = {
    custody: row.custody,
    state: row.state as GrantRecord["state"],
  };
  if (row.credential !== null) rec.credential = reviveCredential(row.credential);
  if (row.profile !== null) rec.profile = row.profile as ProfileRecord;
  if (row.platform !== null && row.accountId !== null) {
    rec.account = { platform: row.platform, accountId: row.accountId };
  }
  if (row.conferredAt !== null) rec.conferredAt = row.conferredAt;
  if (row.lastRenewedAt !== null) rec.lastRenewedAt = row.lastRenewedAt;
  if (row.degradedAt !== null) {
    rec.degraded = { at: row.degradedAt, reason: row.degradedReason ?? "" };
  }
  return rec;
}

export class DrizzleGrantLedger implements GrantLedger {
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(fn: (tx: DrizzleTx) => T): T {
    return this.db.transaction(fn);
  }

  writeConnection(exec: SqliteExec, rec: ConnectionRecord): void {
    exec
      .insert(connections)
      .values({
        id: rec.id,
        connectionKind: rec.connectionKind,
        label: rec.label,
        createdAt: rec.createdAt,
      })
      .run();
  }

  async createConnection(rec: ConnectionRecord): Promise<void> {
    this.writeConnection(this.db, rec);
  }

  async listConnections(): Promise<ConnectionRecord[]> {
    // Oldest first: a connection kind's first Connection is the one that backs its
    // first channel, and readers of `find(connectionKind)[0]` rely on that.
    // `created_at` holds whole seconds, so rowid (write order) breaks a tie.
    const rows = await this.db
      .select()
      .from(connections)
      .orderBy(asc(connections.createdAt), asc(sql`rowid`));
    return rows.map((row) => ({
      id: row.id,
      connectionKind: row.connectionKind,
      label: row.label,
      createdAt: row.createdAt,
    }));
  }

  async deleteConnection(id: ConnectionId, inTx?: (tx: DrizzleTx) => void): Promise<void> {
    this.runInTransaction((tx) => {
      tx.delete(connectionGrants).where(eq(connectionGrants.custody, id)).run();
      tx.delete(connections).where(eq(connections.id, id)).run();
      inTx?.(tx);
    });
  }

  writeEnsureGrant(exec: SqliteExec, custody: string): void {
    exec
      .insert(connectionGrants)
      .values({ custody, state: "unauthorized" })
      .onConflictDoNothing({ target: connectionGrants.custody })
      .run();
  }

  async ensureGrant(custody: string): Promise<void> {
    this.writeEnsureGrant(this.db, custody);
  }

  async getGrant(custody: string): Promise<GrantRecord | null> {
    const rows = await this.db
      .select()
      .from(connectionGrants)
      .where(eq(connectionGrants.custody, custody));
    const row = rows[0];
    return row ? rowToGrant(row) : null;
  }

  writeGrant(exec: SqliteExec, custody: string, value: GrantValue): void {
    exec
      .update(connectionGrants)
      .set({
        state: value.state,
        credential: value.credential ?? null,
        profile: value.profile ?? null,
        platform: value.account?.platform ?? null,
        accountId: value.account?.accountId ?? null,
        conferredAt: value.conferredAt ?? null,
        lastRenewedAt: value.lastRenewedAt ?? null,
        degradedAt: value.degraded?.at ?? null,
        degradedReason: value.degraded?.reason ?? null,
      })
      .where(eq(connectionGrants.custody, custody))
      .run();
  }

  async updateGrant(custody: string, next: (current: GrantValue) => GrantValue): Promise<void> {
    this.runInTransaction((tx) => {
      const row = tx
        .select()
        .from(connectionGrants)
        .where(eq(connectionGrants.custody, custody))
        .get();
      this.writeGrant(tx, custody, next(grantValueOf(row ? rowToGrant(row) : null)));
    });
  }

  async connectionReaching(
    account: GrantAccount,
    exceptId: ConnectionId,
  ): Promise<ConnectionId | null> {
    const rows = await this.db
      .select({ id: connectionGrants.custody })
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.platform, account.platform),
          eq(connectionGrants.accountId, account.accountId),
          ne(connectionGrants.state, "unauthorized"),
          ne(connectionGrants.custody, exceptId),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async heldGrantsWithoutAccount(exceptId: ConnectionId): Promise<GrantRecord[]> {
    const rows = await this.db
      .select()
      .from(connectionGrants)
      .where(
        and(
          isNull(connectionGrants.accountId),
          isNotNull(connectionGrants.profile),
          ne(connectionGrants.state, "unauthorized"),
          ne(connectionGrants.custody, exceptId),
        ),
      );
    return rows.map(rowToGrant);
  }
}
