// An account exists only while it is connected. Model:
// docs/concepts/messaging.md#channels.

import { createLogger } from "../logger.js";
import type { GrantRecord } from "./ledger.js";
import type { ConnectionRegistry } from "./registry.js";
import type { Connection } from "./types.js";

const log = createLogger("connections");

/** The grants of `conn` when it is an account no grant connects (a
 *  Connection of a service with a Talk whose every grant is unauthorized),
 *  and null otherwise. A service without a Talk, or with no grants at all (a
 *  zero-grant channel), keeps its Connection. */
async function unconnectedGrants(
  registry: Pick<ConnectionRegistry, "getDescriptor" | "getLedger">,
  conn: Pick<Connection, "id" | "service">,
): Promise<GrantRecord[] | null> {
  if (!registry.getDescriptor(conn.service)?.capabilities.talker) return null;
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
 * Remove every account that was never connected, for the boot pass. Before
 * an account existed only while connected, "Add another account" made one
 * ahead of its setup, so an upgrade can find some. An account disconnected
 * back then stays: its grants no longer name the account, so its channel
 * could never be matched to it again. Answers the ids it removed; one that
 * fails is logged and kept.
 */
export async function removeNeverConnectedAccounts(
  registry: Pick<ConnectionRegistry, "all" | "getDescriptor" | "getLedger" | "remove">,
): Promise<string[]> {
  const removed: string[] = [];
  for (const conn of registry.all()) {
    try {
      const grants = await unconnectedGrants(registry, conn);
      if (!grants || grants.some((grant) => grant.conferredAt !== undefined)) continue;
      await registry.remove(conn.id);
      removed.push(conn.id);
    } catch (error) {
      // A leftover row must not keep Rome from starting; the next boot retries it.
      log.warn("could not remove an account that was never connected", { id: conn.id, error });
    }
  }
  if (removed.length > 0) log.info("removed accounts that were never connected", { removed });
  return removed;
}
