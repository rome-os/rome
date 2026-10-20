// An account exists only while it is connected. Model:
// docs/concepts/messaging.md#channels.

import { createLogger } from "../logger.js";
import type { GrantRecord } from "./ledger.js";
import type { ConnectionRegistry } from "./registry.js";
import type { Connection } from "./types.js";

const log = createLogger("connections");

/** The grants of `conn` when it is an account no grant connects, and null
 *  otherwise. An account here is a Connection of a service with a Talk that
 *  names its accounts, so the same account connecting again can take its
 *  channel back. Any other Connection (email, a zero-grant channel, a service
 *  without a Talk) stays after its last grant goes. */
async function unconnectedGrants(
  registry: Pick<ConnectionRegistry, "getDescriptor" | "getLedger">,
  conn: Pick<Connection, "id" | "service">,
): Promise<GrantRecord[] | null> {
  const descriptor = registry.getDescriptor(conn.service);
  if (!descriptor?.capabilities.talker || !descriptor.accountIdOf) return null;
  const grants = await registry.getLedger().listGrants(conn.id);
  return grants.length > 0 && grants.every((grant) => grant.state === "unauthorized")
    ? grants
    : null;
}

/** Whether `conn` is an account no grant connects. Such a Connection is
 *  removed, along with its channel. */
export async function isUnconnectedAccount(
  registry: Pick<ConnectionRegistry, "getDescriptor" | "getLedger">,
  conn: Pick<Connection, "id" | "service">,
): Promise<boolean> {
  return (await unconnectedGrants(registry, conn)) !== null;
}

/**
 * Remove the accounts no grant connects, for the boot pass: those never
 * connected, which "Add another account" made ahead of its setup before an
 * account existed only while connected, and those whose channel names their
 * account, which a failed removal on disconnect left behind. An account
 * disconnected before channels named their accounts stays, since nothing
 * could take its channel back. Answers the ids it removed; one that fails is
 * logged and kept.
 */
export async function removeUnconnectedAccounts(
  registry: Pick<ConnectionRegistry, "all" | "getDescriptor" | "getLedger" | "remove">,
  channelNamesAccount: (connectionId: string) => boolean,
): Promise<string[]> {
  const removed: string[] = [];
  for (const conn of registry.all()) {
    try {
      const grants = await unconnectedGrants(registry, conn);
      if (!grants) continue;
      const neverConnected = grants.every((grant) => grant.conferredAt === undefined);
      if (!neverConnected && !channelNamesAccount(conn.id)) continue;
      await registry.remove(conn.id);
      removed.push(conn.id);
    } catch (error) {
      // A leftover row must not keep Rome from starting; the next boot retries it.
      log.warn("could not remove an account no grant connects", { id: conn.id, error });
    }
  }
  if (removed.length > 0) log.info("removed accounts no grant connects", { removed });
  return removed;
}
