/**
 * The boot pass that records a channel for each Connection from before
 * channels were recorded. Vocabulary: docs/concepts/messaging.md#channels.
 */

import type { DrizzleDb } from "../db/index.js";
import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";

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
