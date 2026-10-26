// Where connections are kept. Vocabulary: docs/domains/connections.md.

import type { DrizzleTx, SqliteExec } from "../db/index.js";
import type { GrantAccount, GrantRecord, GrantValue } from "./grant.js";
import type { ConnectionId } from "./types.js";

/** What a connection is apart from its grant. */
export interface ConnectionRecord {
  id: ConnectionId;
  connectionKind: string;
  label: string;
  createdAt: Date;
}

/** A connection as it is kept: its record and the one grant it holds. A
 *  connection with no grant held holds `NO_GRANT`. */
export interface StoredConnection extends ConnectionRecord {
  grant: GrantValue;
}

/**
 * The connections Rome holds. A connection is loaded and saved whole, its
 * grant with it, and a save replaces what was kept. Writes take an executor,
 * the db or a caller's transaction, so the registry can enlist a save with
 * the writes of another context in one transaction.
 *
 * At most one connection reaches an account, across every kind on its
 * platform: the store refuses a save that would make a second.
 */
export interface ConnectionsRepository {
  /** Every connection, oldest first. A connection kind's first connection is
   *  the one that backs its first channel, and readers rely on that. */
  all(): Promise<StoredConnection[]>;
  get(id: ConnectionId): Promise<StoredConnection | null>;
  /** The grant `id` holds, or null when no connection `id` is kept. */
  grantOf(id: ConnectionId): Promise<GrantValue | null>;
  /** The connection, other than `exceptId`, holding a grant in any state but
   *  "unauthorized" that reaches `account`, or null. */
  reaching(account: GrantAccount, exceptId: ConnectionId): Promise<ConnectionId | null>;
  /** The grants, outside `exceptId`, held in any state but "unauthorized" with
   *  a profile and no stored account: those the boot pass left without one. */
  heldWithoutAccount(exceptId: ConnectionId): Promise<GrantRecord[]>;
  /** Run `fn` inside one synchronous transaction. Any throw rolls the whole
   *  scope back. */
  transaction<T>(fn: (tx: DrizzleTx) => T): T;
  /** Keep `connection` as it is given, replacing its grant whole. A
   *  connection's record never changes once kept. */
  save(exec: SqliteExec, connection: StoredConnection): void;
  /** Remove connection `id` and its grant. */
  remove(exec: SqliteExec, id: ConnectionId): void;
  /** Replace connection `id` with `next` of the one kept, read and saved in
   *  one transaction. `next` is pure: it reads the clock or anything else
   *  outside the connection before the call, not inside it. `inTx` runs in the
   *  same transaction once the save is written. Does nothing when no
   *  connection `id` is kept. */
  update(
    id: ConnectionId,
    next: (current: StoredConnection) => StoredConnection,
    inTx?: (tx: DrizzleTx) => void,
  ): Promise<void>;
}
