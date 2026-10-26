// An account exists only while it is connected. Model:
// docs/domains/chats.md#account.

import { createLogger } from "../logger.js";
import type { ConnectionRegistry } from "./registry.js";
import type { Connection } from "./types.js";

const log = createLogger("connections");

/** Whether `conn` is an account no grant connects. An account here is a
 *  Connection of a connection kind with a Talk whose accounts take an agent, and it
 *  is removed, along with its channel, once its grant is
 *  unauthorized. Any other Connection (email, a connection kind without a Talk)
 *  stays after its grant goes. */
export async function isUnconnectedAccount(
  registry: Pick<ConnectionRegistry, "getDescriptor" | "getLedger">,
  conn: Pick<Connection, "id" | "connectionKind">,
): Promise<boolean> {
  const descriptor = registry.getDescriptor(conn.connectionKind);
  if (!descriptor?.capabilities.talker || !descriptor.takesAgent) return false;
  const grant = await registry.getLedger().getGrant(conn.id);
  return grant?.state === "unauthorized";
}

/**
 * Remove every unconnected account, for the boot pass. Before an account
 * existed only while connected, "Add another account" made one ahead of its
 * setup and Disconnect left the Connection behind, so an upgrade can find
 * either, and a removal that failed on disconnect leaves one too. Answers the
 * ids it removed; one that fails is logged and kept.
 */
export async function removeUnconnectedAccounts(
  registry: Pick<ConnectionRegistry, "all" | "getDescriptor" | "getLedger" | "remove">,
): Promise<string[]> {
  const removed: string[] = [];
  for (const conn of registry.all()) {
    try {
      if (!(await isUnconnectedAccount(registry, conn))) continue;
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
