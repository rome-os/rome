/**
 * The boot pass that records a channel for each Connection from before
 * channels were recorded. Vocabulary: docs/domains/chats.md#account.
 */

import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import type { DrizzleDb } from "../db/index.js";
import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";

/**
 * Record a channel for every Connection that has none. A Connection minted
 * after channels were recorded got its channel in the same transaction, so
 * this only reaches Connections from before. A service held one Connection
 * then, so each takes its service's own name. Such an account answered as
 * main before accounts took agents, so it keeps main, as migration 0081 kept
 * it for the channels recorded then. `domainOf` answers a Feishu
 * app's domain, and is asked only of a Connection that has no channel.
 */
export async function claimChannels(
  db: DrizzleDb,
  records: Pick<ChannelRecordsRepository, "claim" | "unclaimed">,
  connections: ReadonlyArray<{ id: string; service: string }>,
  domainOf: (connectionId: string) => Promise<string | undefined> = async () => undefined,
): Promise<void> {
  const unclaimed = records.unclaimed(connections);
  if (unclaimed.length === 0) return;
  const domains = await Promise.all(unclaimed.map((connection) => domainOf(connection.id)));
  const now = new Date();
  db.transaction((tx) => {
    for (const [i, connection] of unclaimed.entries()) {
      records.claim(tx, { ...connection, domain: domains[i] }, now, { agent: MAIN_AGENT_ID });
    }
  });
}
