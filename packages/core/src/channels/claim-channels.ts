/**
 * The boot passes that record a channel for each Connection from before
 * channels were recorded, and the account behind each. Vocabulary: docs/concepts/messaging.md#romes-accounts.
 */

import type { ConnectionRegistry } from "../connections/registry.js";
import type { DrizzleDb } from "../db/index.js";
import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createLogger } from "../logger.js";

const log = createLogger("channels");

/**
 * Record a channel for every Connection that has none. A Connection minted
 * after channels were recorded got its channel in the same transaction, so
 * this only reaches Connections from before. A service held one Connection
 * then, so each takes its service's own name.
 */
export function claimChannels(
  db: DrizzleDb,
  records: Pick<ChannelRecordsRepository, "claim" | "unclaimed">,
  connections: ReadonlyArray<{ id: string; service: string }>,
): void {
  const unclaimed = records.unclaimed(connections);
  if (unclaimed.length === 0) return;
  const now = new Date();
  db.transaction((tx) => {
    for (const connection of unclaimed) records.claim(tx, connection, now);
  });
}

/**
 * Record the account behind each backed channel that has none recorded, for
 * channels from before accounts were recorded. The account comes from the
 * identity a grant of the channel's Connection reports, so a channel whose
 * grants report none stays without one, and a later Connection cannot take it
 * back.
 */
export async function recordChannelAccounts(
  db: DrizzleDb,
  records: Pick<ChannelRecordsRepository, "byConnection" | "setAccount">,
  registry: Pick<ConnectionRegistry, "getDescriptor" | "getLedger">,
  connections: ReadonlyArray<{ id: string; service: string }>,
): Promise<void> {
  for (const connection of connections) {
    const accountIdOf = registry.getDescriptor(connection.service)?.accountIdOf;
    if (!accountIdOf || records.byConnection(connection.id)?.account !== null) continue;
    try {
      for (const grant of await registry.getLedger().listGrants(connection.id)) {
        const account = grant.profile ? accountIdOf(grant.name, grant.profile) : null;
        if (account) {
          records.setAccount(db, connection.id, account);
          break;
        }
      }
    } catch (error) {
      // Without it the channel only misses being taken back on a reconnect;
      // the next boot tries again.
      log.warn("could not record a channel's account", { connectionId: connection.id, error });
    }
  }
}
