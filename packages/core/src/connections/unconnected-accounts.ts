// An account exists only while it is connected. Model:
// docs/concepts/messaging.md#channels.

import { createLogger } from "../logger.js";
import type { ConnectionRegistry } from "./registry.js";
import type { Connection } from "./types.js";

const log = createLogger("connections");

/** Whether `conn` is an account no grant connects: a Connection of a service
 *  with a Talk whose every grant is unauthorized. Such a Connection is
 *  removed, along with its channel. A service without a Talk, or with no
 *  grants at all (a zero-grant channel), keeps its Connection. */
export async function isUnconnectedAccount(
  registry: Pick<ConnectionRegistry, "getDescriptor" | "getLedger">,
  conn: Pick<Connection, "id" | "service">,
): Promise<boolean> {
  if (!registry.getDescriptor(conn.service)?.capabilities.talker) return false;
  const grants = await registry.getLedger().listGrants(conn.id);
  return grants.length > 0 && grants.every((grant) => grant.state === "unauthorized");
}

/**
 * Remove every unconnected account, for the boot pass. Before an account
 * existed only while connected, "Add another account" made one ahead of its
 * setup and Disconnect left the Connection behind, so an upgrade can find
 * either. Answers the ids it removed.
 */
export async function removeUnconnectedAccounts(
  registry: Pick<ConnectionRegistry, "all" | "getDescriptor" | "getLedger" | "remove">,
): Promise<string[]> {
  const removed: string[] = [];
  for (const conn of registry.all()) {
    if (!(await isUnconnectedAccount(registry, conn))) continue;
    await registry.remove(conn.id);
    removed.push(conn.id);
  }
  if (removed.length > 0) log.info("removed accounts no grant connects", { removed });
  return removed;
}
