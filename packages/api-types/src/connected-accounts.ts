/**
 * The wire shapes of connected accounts.
 * Vocabulary: docs/domains/chats.md#connected-account.
 */

import type { Account } from "@rome-os/app-runtime";
import type { AccountLink } from "./account-agents.js";

/** An account, the same wherever it is seen: the platform it is on and the
 *  platform's own id for it. The SDK's `Account`, which apps pass to send as
 *  one of Rome's accounts. Vocabulary: docs/domains/chats.md#account. */
export type AccountValue = Account;

/**
 * The account fields of one entry in `GET /api/connections`. Each is optional
 * because a core that predates several accounts omits them, and the dashboard
 * renders as before when one is absent.
 */
export interface ConnectionAccountFields {
  /** The id of the dashboard card this Connection shows on, which is its
   *  channel's: the first channel of a service is named after it (`feishu`),
   *  and later ones get an opaque id. Null for placeholders and services
   *  without a Talk. Commands name the connection, never this. */
  channel?: string | null;
  /** Platform of the account this Connection reaches (`telegram`, `lark`),
   *  as `account` names it. Null until the grant reports an account. */
  platform?: string | null;
  /** The account the connection's grant reaches, or null until the grant
   *  reports one, and for placeholders. */
  account?: AccountValue | null;
  /** Canonical id of the agent that answers on this account (`core:main`,
   *  `core:concierge`), which its kind of connection decides. A core from
   *  before that reports null for an account with no agent. Absent for
   *  placeholders and for a service that takes no agent. */
  agent?: string | null;
  /** The kind of link this account's agent has, which its kind of connection
   *  decides, placeholders included. Null for a kind that takes no agent.
   *  Absent from a core that predates it. */
  link?: AccountLink | null;
  /** Whether the service offers "add another account". */
  severalAccounts?: boolean;
  /** True when the account's channel does not know which account it is.
   *  Such a channel is not active: it hears and sends nothing until a grant
   *  reports its account. Absent for placeholders and services without a
   *  Talk. */
  accountUnknown?: boolean;
}
