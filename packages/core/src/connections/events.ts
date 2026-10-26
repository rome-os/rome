// Connection domain events. Vocabulary: docs/domains/connections.md.

import type { DrizzleTx } from "../db/index.js";
import type { GrantAccount } from "./grant.js";
import type { ConnectionRecord } from "./repository.js";
import type { ConnectionId, ProfileRecord } from "./types.js";

/** The connection an event is about, by identity and kind. */
export interface ConnectionRef {
  id: ConnectionId;
  connectionKind: string;
}

/** What happened to a connection, raised inside the transaction that saved
 *  it, so whatever another context records for it commits or rolls back with
 *  the connection.
 *
 *  - `connected`: the connection was saved for the first time. `profile` and
 *    `account` are the grant's, and absent when it was minted holding no grant.
 *  - `fixed`: a conferral replaced the grant of a connection that already
 *    existed. `account` is the account the new grant reaches, when it names one.
 *  - `revoked`: the connection's grant was revoked, so it reaches no account
 *    until a conferral fills it again. Disconnecting revokes, then removes.
 *  - `disconnected`: the connection was removed. */
export type ConnectionEvent =
  | {
      kind: "connected";
      connection: ConnectionRecord;
      profile?: ProfileRecord;
      account?: GrantAccount;
    }
  | { kind: "fixed"; connection: ConnectionRef; account?: GrantAccount }
  | { kind: "revoked"; connection: ConnectionRef }
  | { kind: "disconnected"; connection: ConnectionRef };

/** A subscriber to connection events. It runs synchronously inside the
 *  transaction, and a throw rolls the connection's write back. */
export type ConnectionEventHandler = (tx: DrizzleTx, event: ConnectionEvent) => void;
