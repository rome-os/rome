// Connection grant ledger. Vocabulary: docs/domains/connections.md.
//
// Invariants the implementations and tests hold:
//  1. Runtime never reads inside `material` — only the envelope (`expiresAt`, kind).
//  2. Rehydration needs code, never the guardian: a persisted credential +
//     descriptor ⇒ a live capability at boot.
//  3. Rows record outcomes only — no step/flow state, no scheme-specific columns.
//  4. A connection holds one grant, in one row keyed by the connection. A
//     grant is a value: conferral, renewal and kit.persist each replace it whole.
//  5. The grant row exists from connection creation in "unauthorized";
//     conferral FILLS it.

import type { DrizzleTx, SqliteExec } from "../db/index.js";
import type { ConnectionId, GrantState, ProfileRecord, SecretRecord } from "./types.js";

export interface ConnectionRecord {
  id: ConnectionId;
  connectionKind: string;
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

/** The account a grant reaches: its platform and the platform's own id for it,
 *  read from the grant's profile when access was given. */
export interface GrantAccount {
  platform: string;
  accountId: string;
}

export interface GrantRecord {
  custody: string; // connectionId
  state: GrantState;
  credential?: PersistedCredential; // present ⇔ state !== "unauthorized"
  /** The non-secret half of the conferral outcome, written in the
   *  SAME update as `credential` — never through a separate setter. Absent until
   *  a conferral supplies one; degrade preserves it (no wipe), revoke clears it. */
  profile?: ProfileRecord;
  /** The account the profile names, written in the same update as the profile
   *  and cleared with it. Absent when the profile names none. At most one grant
   *  in any state but "unauthorized" reaches an account. */
  account?: GrantAccount;
  /** When the current conferral filled this grant. Revocation clears it. */
  conferredAt?: Date;
  /** Opaque epoch of the current conferral. Renewals preserve it; a new
   *  conferral replaces it and revocation clears it. */
  conferralEpoch?: string;
  lastRenewedAt?: Date;
  degraded?: { at: Date; reason: string };
}

/** A connection's grant as one value: everything the ledger keeps for it. A
 *  grant has no identity of its own, so every write replaces it whole.
 *  Vocabulary: docs/domains/connections.md#grant. */
export type GrantValue = Omit<GrantRecord, "custody">;

/** What a connection holds when no grant fills it. */
export const NO_GRANT: GrantValue = { state: "unauthorized" };

/** The value of `record`, or NO_GRANT when there is none. */
export function grantValueOf(record: GrantRecord | null): GrantValue {
  if (!record) return NO_GRANT;
  const { custody: _custody, ...value } = record;
  return value;
}

/** Each `write*` helper takes an executor (the db for autocommit, or a `tx`), so
 *  the registry can enlist several writes in one caller-owned transaction. */
export interface GrantLedger {
  createConnection(rec: ConnectionRecord): Promise<void>;
  listConnections(): Promise<ConnectionRecord[]>;
  /** Cascades the connection's grant. `inTx` runs a caller participant in
   *  the same transaction as the deletes, so a teardown side-write commits
   *  atomically with the connection removal. */
  deleteConnection(id: ConnectionId, inTx?: (tx: DrizzleTx) => void): Promise<void>;
  /** Idempotent; creates the connection's grant in "unauthorized" if absent. */
  ensureGrant(custody: string): Promise<void>;
  getGrant(custody: string): Promise<GrantRecord | null>;
  /** Replace the connection's grant whole with `next` of the one it holds,
   *  read and written in one transaction. `next` is pure: it reads the clock
   *  or anything else outside the grant before the call, not inside it. */
  updateGrant(custody: string, next: (current: GrantValue) => GrantValue): Promise<void>;
  /** Run `fn` inside one synchronous transaction (better-sqlite3). Any throw
   *  rolls the whole scope back. */
  runInTransaction<T>(fn: (tx: DrizzleTx) => T): T;
  writeConnection(exec: SqliteExec, rec: ConnectionRecord): void;
  writeEnsureGrant(exec: SqliteExec, custody: string): void;
  /** Replace the connection's grant whole with `value`. */
  writeGrant(exec: SqliteExec, custody: string, value: GrantValue): void;
  /** The Connection, other than `exceptId`, holding a grant in any state but
   *  "unauthorized" that reaches `account`, or null. */
  connectionReaching(account: GrantAccount, exceptId: ConnectionId): Promise<ConnectionId | null>;
  /** The grants, outside `exceptId`, held in any state but "unauthorized" with
   *  a profile and no stored account: those the boot pass left without one. */
  heldGrantsWithoutAccount(exceptId: ConnectionId): Promise<GrantRecord[]>;
}
