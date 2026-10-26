// A connection exists only while it is connected, whatever its kind. Model:
// docs/domains/connections.md#connection.

import { createLogger } from "../logger.js";
import type { ConnectionRegistry } from "./registry.js";
import type { Connection } from "./types.js";

const log = createLogger("connections");

/** Whether `conn` is a connection no grant connects any more: its grant is
 *  unauthorized, so it was disconnected, and it is removed along with its
 *  channel. Every kind of connection ends this way, email, WhatsApp and the
 *  sign-ins such as GitHub included. */
export async function isUnconnectedAccount(
  registry: Pick<ConnectionRegistry, "grantOf">,
  conn: Pick<Connection, "id" | "connectionKind">,
): Promise<boolean> {
  const grant = await registry.grantOf(conn.id);
  return grant?.state === "unauthorized";
}

/**
 * Remove every disconnected connection, for the boot pass. Before a
 * connection existed only while connected, "Add another account" made one
 * ahead of its setup and Disconnect left the Connection behind, and until
 * email, WhatsApp and the sign-ins ended at disconnect too, theirs stayed. An
 * upgrade can find any of these, and a removal that failed on disconnect
 * leaves one too. Answers the ids it removed; one that fails is logged and
 * kept.
 */
export async function removeUnconnectedAccounts(
  registry: Pick<ConnectionRegistry, "all" | "grantOf" | "remove">,
): Promise<string[]> {
  const removed: string[] = [];
  for (const conn of registry.all()) {
    try {
      if (!(await isUnconnectedAccount(registry, conn))) continue;
      await registry.remove(conn.id);
      removed.push(conn.id);
    } catch (error) {
      // A leftover row must not keep Rome from starting; the next boot retries it.
      log.warn("could not remove a connection no grant connects", { id: conn.id, error });
    }
  }
  if (removed.length > 0) log.info("removed connections no grant connects", { removed });
  return removed;
}
