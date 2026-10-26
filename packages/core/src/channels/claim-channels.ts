/**
 * The boot pass that records a channel for each Connection from before
 * channels were recorded. Vocabulary: docs/domains/chats.md#account.
 */

import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import type { GrantLedger } from "../connections/ledger.js";
import type { DrizzleDb } from "../db/index.js";
import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";

/**
 * Record a channel for every Connection that has none. A Connection minted
 * after channels were recorded got its channel in the same transaction, so
 * this only reaches Connections from before. A connection kind held one Connection
 * then, so each takes its connection kind's own name. Such an account answered as
 * main before accounts took agents, so it keeps main, as migration 0081 kept
 * it for the channels recorded then. `domainOf` answers a Feishu
 * app's domain, and is asked only of a Connection that has no channel.
 */
export async function claimChannels(
  db: DrizzleDb,
  records: Pick<ChannelRecordsRepository, "claim" | "unclaimed">,
  connections: ReadonlyArray<{ id: string; connectionKind: string }>,
  domainOf: (connectionId: string) => Promise<string | undefined> = async () => undefined,
): Promise<void> {
  const unclaimed = records.unclaimed(connections);
  if (unclaimed.length === 0) return;
  const domains = await Promise.all(unclaimed.map((connection) => domainOf(connection.id)));
  const now = new Date();
  db.transaction((tx) => {
    for (const [i, connection] of unclaimed.entries()) {
      records.claim(tx, { ...connection, domain: domains[i] }, now, {
        agent: MAIN_AGENT_ID,
        id: connection.connectionKind,
      });
    }
  });
}

/**
 * Record the account each backed channel is, for channels recorded before
 * they knew it: the account its Connection's held grant reaches, once the
 * grant names it. A channel whose Connection holds no such grant stays
 * without one until a grant reports it.
 */
export async function recordChannelAccounts(
  db: DrizzleDb,
  records: Pick<ChannelRecordsRepository, "all" | "recordAccount">,
  ledger: Pick<GrantLedger, "listGrants">,
): Promise<void> {
  const unknown = records
    .all()
    .filter((record) => record.connectionId !== null && record.platformAccountId === null);
  if (unknown.length === 0) return;
  const accounts = await Promise.all(
    unknown.map(async (record) => {
      const grants = await ledger.listGrants(record.connectionId!);
      return grants.find((grant) => grant.state !== "unauthorized" && grant.account)?.account;
    }),
  );
  db.transaction((tx) => {
    for (const [i, record] of unknown.entries()) {
      const account = accounts[i];
      if (account) records.recordAccount(tx, record.connectionId!, account);
    }
  });
}
