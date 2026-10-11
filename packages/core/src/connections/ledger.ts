// Connection grant ledger. Messaging model: docs/concepts/messaging.md.
//
// Invariants the implementations and tests hold:
//  1. Runtime never reads inside `material` — only the envelope (`expiresAt`, kind).
//  2. Rehydration needs code, never the guardian: a persisted credential +
//     descriptor ⇒ a live capability at boot.
//  3. Rows record outcomes only — no step/flow state, no scheme-specific columns.
//  4. One grant = one credential row; renewal and kit.persist replace it in place.
//  5. Grant rows exist from connection creation in "unauthorized"; conferral
//     FILLS them.

import type { DrizzleTx, SqliteExec } from "../db/index.js";
import type { ConnectionId, GrantName, GrantState, ProfileRecord, SecretRecord } from "./types.js";

export interface ConnectionRecord {
  id: ConnectionId;
  service: string;
  label: string;
  createdAt: Date;
}

/**
 * The persisted form of a `Credential`. Inline custody stores the secret record
 * verbatim; external custody (`{ kind: "external" }`) stores no secret — the
 * live material comes from the scheme's `resolveExternal` resolver at rehydration.
 */
export interface PersistedCredential {
  material: { kind: "inline"; record: SecretRecord } | { kind: "external" };
  expiresAt: Date | "never";
}

export interface GrantRecord {
  custody: string; // connectionId
  name: GrantName;
  state: GrantState;
  credential?: PersistedCredential; // present ⇔ state !== "unauthorized"
  /** The non-secret half of the conferral outcome, written in the
   *  SAME update as `credential` — never through a separate setter. Absent until
   *  a conferral supplies one; degrade preserves it (no wipe), revoke clears it. */
  profile?: ProfileRecord;
  /** When the last conferral filled this grant. Retained through `revoke()`. */
  conferredAt?: Date;
  lastRenewedAt?: Date;
  degraded?: { at: Date; reason: string };
}

/** The fields a grant update may change. */
export type GrantPatch = Partial<
  Pick<
    GrantRecord,
    "state" | "credential" | "profile" | "conferredAt" | "lastRenewedAt" | "degraded"
  >
>;

/** Each `write*` helper takes an executor (the db for autocommit, or a `tx`), so
 *  the registry can enlist several writes in one caller-owned transaction. */
export interface GrantLedger {
  createConnection(rec: ConnectionRecord): Promise<void>;
  listConnections(): Promise<ConnectionRecord[]>;
  /** Cascades the connection's grant rows. `inTx` runs a caller participant in
   *  the same transaction as the deletes, so a teardown side-write commits
   *  atomically with the connection removal. */
  deleteConnection(id: ConnectionId, inTx?: (tx: DrizzleTx) => void): Promise<void>;
  /** Idempotent; creates the row in "unauthorized" if absent. */
  ensureGrant(custody: string, name: GrantName): Promise<void>;
  getGrant(custody: string, name: GrantName): Promise<GrantRecord | null>;
  listGrants(custody: string): Promise<GrantRecord[]>;
  updateGrant(custody: string, name: GrantName, patch: GrantPatch): Promise<void>;
  /** Run `fn` inside one synchronous transaction (better-sqlite3). Any throw
   *  rolls the whole scope back. */
  runInTransaction<T>(fn: (tx: DrizzleTx) => T): T;
  writeConnection(exec: SqliteExec, rec: ConnectionRecord): void;
  writeEnsureGrant(exec: SqliteExec, custody: string, name: GrantName): void;
  writeGrant(exec: SqliteExec, custody: string, name: GrantName, patch: GrantPatch): void;
}
