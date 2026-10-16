// Capability-to-grant-state signals. Messaging model: docs/concepts/messaging.md.
//
// `CredentialRejected` is the ONLY bridge from capabilities to grant state: any
// capability that gets "credential refused" from the service (401, invalid_auth,
// session logged out) surfaces this instead of a generic error. The runtime
// reacts by trying renew() once, then degrading the grant. Generic failures
// (timeouts, 500s, disconnects) must NOT use this — they're `Disconnected`,
// answered with backoff + rebuild, and never touch grant state.

import type { ConnectionId, GrantName } from "./types.js";

/** A Service that has more than one connection, with the offending connection
 *  IDs so an operator can resolve the duplicate explicitly. */
export interface DuplicateServiceConnectionGroup {
  service: string;
  connectionIds: ConnectionId[];
}

/**
 * `ConnectionRegistry.connect` mints a Service's first Connection only. IDs are
 * included so an operator can resolve the duplicate explicitly; the registry
 * never selects, merges, or deletes one on its own.
 */
export class DuplicateServiceConnectionsError extends Error {
  readonly duplicates: readonly DuplicateServiceConnectionGroup[];

  constructor(duplicates: readonly DuplicateServiceConnectionGroup[]) {
    const detail = duplicates
      .map(({ service, connectionIds }) => `${service}: ${connectionIds.join(", ")}`)
      .join("; ");
    super(
      `Duplicate Service connections found (${detail}). connect mints only a Service's first connection; remove the existing one first, or add another account of a Service that offers several.`,
    );
    this.name = "DuplicateServiceConnectionsError";
    this.duplicates = duplicates;
  }
}

/**
 * `ConnectionRegistry.confer` refuses a conferral whose account another
 * Connection of the service already holds, because two Connections of one bot
 * run two transports that conflict. The message reads to the guardian on a
 * failed setup, and the conferral writes nothing.
 */
export class AccountAlreadyConnectedError extends Error {
  readonly service: string;
  readonly accountId: string;
  /** The Connection that already holds the account. */
  readonly connectionId: ConnectionId;

  constructor(service: string, accountId: string, connectionId: ConnectionId) {
    super(
      "This bot is already connected as another account. Set up a different bot, or remove that account first.",
    );
    this.name = "AccountAlreadyConnectedError";
    this.service = service;
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
 * Signals a terminal transport failure the builder could not recover. Never
 * touches grant state — the runtime answers with backoff + rebuild.
 */
export class Disconnected extends Error {
  constructor(cause?: unknown) {
    super("disconnected", cause !== undefined ? { cause } : undefined);
    this.name = "Disconnected";
  }
}
