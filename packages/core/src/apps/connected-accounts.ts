/**
 * `ConnectedAccounts`: Rome's accounts as an app acts through them, each with
 * its agent and whether a connection reaches it now. Sending is `Chats.send`,
 * not this. Vocabulary: docs/domains/chats.md#connected-account.
 */

import type { ConnectedAccount, ConnectedAccounts } from "@rome-os/app-runtime/chats";
import type { ConnectedAccountRow } from "../db/repositories/connected-accounts.js";

export interface ConnectedAccountsDeps {
  /** Every connected account, disconnected ones included. */
  rows: () => readonly ConnectedAccountRow[];
}

export function createConnectedAccounts(deps: ConnectedAccountsDeps): ConnectedAccounts {
  return {
    list: async (): Promise<ConnectedAccount[]> =>
      deps.rows().map((row) => ({
        account: { platform: row.platform, id: row.accountId },
        name: row.name,
        agent: row.agent,
        connected: row.connectionId !== null,
      })),
  };
}
