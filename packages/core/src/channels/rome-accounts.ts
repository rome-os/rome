// Rome's own accounts, as an app names them: the platform and the platform's
// id. The connection that reaches an account is core's handle on it, and no
// app sends to that. Vocabulary: docs/domains/chats.md#account.

import type { Account } from "@rome-os/app-runtime";
import type { DrizzleConnectionsRepository } from "../connections/repository-db.js";

/** Between Rome's accounts and the connections that reach them, read in place
 *  so a caller can ask per message. */
export interface RomeAccounts {
  /** The account a connection reaches, or null until its grant reports one. */
  accountOf(connectionId: string): Account | null;
  /** The connection that reaches `account`, or null when none of Rome's does. */
  holderOf(account: Account): string | null;
}

export function romeAccounts(
  store: Pick<DrizzleConnectionsRepository, "accountOf" | "holderOf">,
): RomeAccounts {
  return {
    accountOf(connectionId) {
      const account = store.accountOf(connectionId);
      return account ? { platform: account.platform, id: account.accountId } : null;
    },
    holderOf(account) {
      return store.holderOf({ platform: account.platform, accountId: account.id });
    },
  };
}

/** Whether an app named an account, where a host that predates accounts takes
 *  a channel's name. */
export function isAccount(target: Account | string): target is Account {
  return typeof target !== "string";
}

/** An account as a log line or an error names it. */
export function accountLabel(account: Account): string {
  return `${account.platform}:${account.id}`;
}
