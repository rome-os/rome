/**
 * `ConnectedAccounts`: Rome's accounts as an app acts through them, each with
 * its agent and whether a connection reaches it now. Sending is `Chats.send`,
 * not this. Vocabulary: docs/domains/chats.md#connected-account.
 */

import type { Account, ChannelMessage, ChannelMessageQuery } from "@rome-os/app-runtime";
import type { ConnectedAccount, ConnectedAccounts } from "@rome-os/app-runtime/chats";
import type { ConnectedAccountRow } from "../db/repositories/connected-accounts.js";

export interface ConnectedAccountsDeps {
  /** Every connected account, disconnected ones included. */
  rows: () => readonly ConnectedAccountRow[];
  /** What each account is called, from its profile, in the order given. */
  names: (accounts: readonly Account[]) => Promise<ReadonlyArray<string | null>>;
  /** What was said through an account, from its kind's history. */
  query: (account: Account, query: ChannelMessageQuery) => Promise<ChannelMessage[]>;
}

export function createConnectedAccounts(deps: ConnectedAccountsDeps): ConnectedAccounts {
  return {
    async list(): Promise<ConnectedAccount[]> {
      const rows = deps.rows();
      const accounts = rows.map((row) => ({ platform: row.platform, id: row.accountId }));
      const names = await deps.names(accounts);
      return rows.map((row, index) => ({
        account: accounts[index]!,
        name: names[index] ?? null,
        agent: row.agent,
        connected: row.connectionId !== null,
      }));
    },
    query: (account, query = {}) =>
      deps.query({ platform: account.platform, id: account.id }, query),
  };
}
