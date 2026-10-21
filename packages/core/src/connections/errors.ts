// Capability-to-grant-state signals. Vocabulary: docs/domains/connections.md.
//
// `CredentialRejected` is the ONLY bridge from capabilities to grant state: any
// capability that gets "credential refused" from the service (401, invalid_auth,
// session logged out) surfaces this instead of a generic error. The runtime
// reacts by trying renew() once, then degrading the grant. Generic failures
// (timeouts, 500s, disconnects) must NOT use this — they're `Disconnected`,
// answered with backoff + rebuild, and never touch grant state.

import type { ConnectionId, GrantName } from "./types.js";

/** A connection kind that has more than one connection, with the offending connection
 *  IDs so an operator can resolve the duplicate explicitly. */
export interface DuplicateKindConnectionGroup {
  connectionKind: string;
  connectionIds: ConnectionId[];
}

/**
 * `ConnectionRegistry.connect` mints a connection kind's first Connection only. IDs are
 * included so an operator can resolve the duplicate explicitly; the registry
 * never selects, merges, or deletes one on its own.
 */
export class DuplicateKindConnectionsError extends Error {
  readonly duplicates: readonly DuplicateKindConnectionGroup[];

  constructor(duplicates: readonly DuplicateKindConnectionGroup[]) {
    const detail = duplicates
      .map(({ connectionKind, connectionIds }) => `${connectionKind}: ${connectionIds.join(", ")}`)
      .join("; ");
    super(
      `Duplicate connections of one connection kind found (${detail}). connect mints only a connection kind's first connection; remove the existing one first, or add another account of a connection kind that offers several.`,
    );
    this.name = "DuplicateKindConnectionsError";
    this.duplicates = duplicates;
  }
}

/**
 * `ConnectionRegistry.confer` refuses a conferral whose account another
 * Connection of the connection kind already holds, because two Connections of one bot
 * run two transports that conflict. The message reads to the guardian on a
 * failed setup, and the conferral writes nothing.
 */
export class AccountAlreadyConnectedError extends Error {
  readonly connectionKind: string;
  readonly accountId: string;
  /** The Connection that already holds the account. */
  readonly connectionId: ConnectionId;

  constructor(connectionKind: string, accountId: string, connectionId: ConnectionId) {
    super(
      "This account is already connected. Connect a different account, or disconnect that one first.",
    );
    this.name = "AccountAlreadyConnectedError";
    this.connectionKind = connectionKind;
    this.accountId = accountId;
    this.connectionId = connectionId;
  }
}

/**
 * Signals a refused credential (use → auth). The optional `grant` pins which
 * grant was refused when a capability needs several; without it, the runtime
 * treats every grant the capability needs as suspect.
 */
export class CredentialRejected extends Error {
  readonly grant?: GrantName;

  constructor(opts?: { grant?: GrantName; cause?: unknown }) {
    super("credential rejected", opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "CredentialRejected";
    this.grant = opts?.grant;
  }
}

/**
 * A scheme's `renew()` couldn't reach the party that renews the credential (a
 * network error, a timeout, a 429 or 5xx). Unlike a refusal, the credential may
 * still renew later, so the registry keeps the grant authorized and retries on
 * its next renewal pass instead of degrading it.
 */
export class RenewalUnavailable extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "RenewalUnavailable";
  }
}

/**
 * Signals a terminal transport failure the builder could not recover. Never
 * touches grant state — the runtime answers with backoff + rebuild.
 */
export class Disconnected extends Error {
  constructor(cause?: unknown) {
    super("disconnected", cause !== undefined ? { cause } : undefined);
    this.name = "Disconnected";
  }
}

/**
 * `ConnectionRegistry.confer` refuses to put a different account onto a
 * Connection whose grant still names its own, because the new account would
 * take over that account's channel, history and agent. The message reads to
 * the guardian on a failed setup, and the conferral writes nothing.
 */
export class DifferentAccountError extends Error {
  readonly connectionKind: string;
  readonly connectionId: ConnectionId;

  constructor(connectionKind: string, connectionId: ConnectionId, severalAccounts: boolean) {
    super(
      severalAccounts
        ? "This is a different account. Reconnect with the same account, or add this one as another account."
        : "This is a different account. Reconnect with the same account, or disconnect this one first.",
    );
    this.name = "DifferentAccountError";
    this.connectionKind = connectionKind;
    this.connectionId = connectionId;
  }
}
