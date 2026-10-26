// Drizzle-backed connections repository. Vocabulary: docs/domains/connections.md.
// Keeps each connection in the `connections` table and its one grant in
// `connection_grants`, keyed by the connection. The registry contract suites
// (registry-*.test.ts) run against this implementation.
//
// The `credential` column stores a PersistedCredential envelope as plain JSON
// (encryption was deliberately dropped). The envelope shape is kept so
// encryption can return later. The runtime never reads inside `material`.

import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx, SqliteExec } from "../db/index.js";
import { connectionGrants, connections } from "../db/schema/system.js";
import type { ConnectionId, ProfileRecord } from "./types.js";
import {
  type GrantAccount,
  type GrantRecord,
  type GrantValue,
  grantValueOf,
  type PersistedCredential,
} from "./grant.js";
import type { ConnectionRecord, ConnectionsRepository, StoredConnection } from "./repository.js";

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
  if (row.grantedAt !== null) rec.grantedAt = row.grantedAt;
  if (row.grantEpoch !== null) rec.grantEpoch = row.grantEpoch;
  if (row.lastRenewedAt !== null) rec.lastRenewedAt = row.lastRenewedAt;
  if (row.degradedAt !== null) {
    rec.degraded = { at: row.degradedAt, reason: row.degradedReason ?? "" };
  }
  return rec;
}

type ConnectionRow = typeof connections.$inferSelect;

function rowToRecord(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    connectionKind: row.connectionKind,
    label: row.label,
    createdAt: row.createdAt,
  };
}

/** The grant row's columns for `value`: every field the value leaves out is
 *  null, so a save replaces the grant whole. */
function grantColumns(value: GrantValue) {
  return {
    state: value.state,
    credential: value.credential ?? null,
    profile: value.profile ?? null,
    platform: value.account?.platform ?? null,
    accountId: value.account?.accountId ?? null,
    grantedAt: value.grantedAt ?? null,
    grantEpoch: value.grantEpoch ?? null,
    lastRenewedAt: value.lastRenewedAt ?? null,
    degradedAt: value.degraded?.at ?? null,
    degradedReason: value.degraded?.reason ?? null,
  };
}

export class DrizzleConnectionsRepository implements ConnectionsRepository {
  constructor(private readonly db: DrizzleDb) {}

  transaction<T>(fn: (tx: DrizzleTx) => T): T {
    return this.db.transaction(fn);
  }

  async all(): Promise<StoredConnection[]> {
    return this.readAll(this.db);
  }

  async get(id: ConnectionId): Promise<StoredConnection | null> {
    return this.read(this.db, id);
  }

  async grantOf(id: ConnectionId): Promise<GrantValue | null> {
    return this.read(this.db, id)?.grant ?? null;
  }

  save(exec: SqliteExec, connection: StoredConnection): void {
    exec
      .insert(connections)
      .values({
        id: connection.id,
        connectionKind: connection.connectionKind,
        label: connection.label,
        createdAt: connection.createdAt,
      })
      .onConflictDoNothing({ target: connections.id })
      .run();
    const columns = grantColumns(connection.grant);
    exec
      .insert(connectionGrants)
      .values({ custody: connection.id, ...columns })
      .onConflictDoUpdate({ target: connectionGrants.custody, set: columns })
      .run();
  }

  remove(exec: SqliteExec, id: ConnectionId): void {
    exec.delete(connectionGrants).where(eq(connectionGrants.custody, id)).run();
    exec.delete(connections).where(eq(connections.id, id)).run();
  }

  async update(
    id: ConnectionId,
    next: (current: StoredConnection) => StoredConnection,
    inTx?: (tx: DrizzleTx) => void,
  ): Promise<void> {
    this.transaction((tx) => {
      const current = this.read(tx, id);
      if (!current) return;
      this.save(tx, next(current));
      inTx?.(tx);
    });
  }

  async reaching(account: GrantAccount, exceptId: ConnectionId): Promise<ConnectionId | null> {
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

  async heldWithoutAccount(exceptId: ConnectionId): Promise<GrantRecord[]> {
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

  private read(exec: DrizzleDb | DrizzleTx, id: ConnectionId): StoredConnection | null {
    const row = exec
      .select({ connection: connections, grant: connectionGrants })
      .from(connections)
      .leftJoin(connectionGrants, eq(connectionGrants.custody, connections.id))
      .where(eq(connections.id, id))
      .get();
    if (!row) return null;
    return {
      ...rowToRecord(row.connection),
      grant: grantValueOf(row.grant ? rowToGrant(row.grant) : null),
    };
  }

  private readAll(exec: DrizzleDb | DrizzleTx): StoredConnection[] {
    // `created_at` holds whole seconds, so rowid (write order) breaks a tie.
    return exec
      .select({ connection: connections, grant: connectionGrants })
      .from(connections)
      .leftJoin(connectionGrants, eq(connectionGrants.custody, connections.id))
      .orderBy(asc(connections.createdAt), asc(sql`${connections}.rowid`))
      .all()
      .map((row) => ({
        ...rowToRecord(row.connection),
        grant: grantValueOf(row.grant ? rowToGrant(row.grant) : null),
      }));
  }
}
