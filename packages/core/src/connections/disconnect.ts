// Disconnecting one connection, as the Connections page's Disconnect and the
// agent tool `system:disconnect_service` (agent-tools.ts) both do. Vocabulary:
// docs/domains/connections.md#connection.

import type { ConnectionRegistry } from "./registry.js";
import type { Connection } from "./types.js";

export type DisconnectOutcome =
  | { status: "not-found" }
  /** `warning` is set when the platform may still hold Rome's access. */
  | { status: "disconnected"; connection: Connection; warning?: string };

/**
 * Ends the connection with `connectionId`. A kind that takes back its access
 * at the platform ends as a disconnect does, so the access is never left
 * behind unannounced: when taking it back fails, the outcome carries a
 * warning to tell the guardian.
 */
export async function disconnectConnection(
  registry: Pick<ConnectionRegistry, "all" | "getDescriptor" | "disconnect" | "remove">,
  connectionId: string,
): Promise<DisconnectOutcome> {
  const connection = registry.all().find((c) => c.id === connectionId);
  if (!connection) return { status: "not-found" };
  if (registry.getDescriptor(connection.connectionKind)?.onDisconnect) {
    const ended = await registry.disconnect(connection.id);
    return { status: "disconnected", connection, ...accessKept(ended) };
  }
  await registry.remove(connection.id);
  return { status: "disconnected", connection };
}

/** The warning a disconnect answers with when the platform may still hold
 *  Rome's access. */
export function accessKept(ended: { notTakenBack?: string }): { warning?: string } {
  return ended.notTakenBack
    ? {
        warning: `Disconnected in Rome, but the service may still hold Rome's access: ${ended.notTakenBack}. Remove Rome there too.`,
      }
    : {};
}
