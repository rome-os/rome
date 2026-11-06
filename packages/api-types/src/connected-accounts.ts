/**
 * The wire shapes of connected accounts and the agents linked to them. A
 * connected account is named by its account, or, on the older routes, by the
 * id of the connection that reaches it.
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
  /** Canonical id of the agent linked to this account (`sales:agent`,
   *  `core:main`), or null when none is, which leaves the account silent.
   *  Absent for placeholders and for a service that takes no link. */
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

/** Body of `PUT /api/accounts/:id/agent`, where `:id` is the connection's id.
 *  Null unlinks the account, which leaves it silent. */
export interface LinkAccountAgentRequest {
  agent: string | null;
}

/** The connected account as it stands after the link. A link changes no other
 *  account: an agent may be linked to any number of accounts, several on one
 *  platform included. */
export interface LinkAccountAgentResult {
  account: {
    /** The connection's id, which is the connected account's. */
    id: string;
    /** Canonical id of the account's agent, or null when it is silent. */
    agent: string | null;
    /** The kind of link the account's agent has, or null when its kind of
     *  connection takes no agent. */
    link: AccountLink | null;
  };
}

/** One entry of `GET /api/connected-accounts`: a connected account, whether or not a
 *  connection reaches it now. Disconnecting leaves the account and its agent,
 *  and connecting the same account again finds them. */
export interface ConnectedAccountEntry {
  account: AccountValue;
  /** The name the platform last gave the account, when Rome has learned one. */
  name: string | null;
  /** Canonical id of the account's agent, or null when it has none. */
  agent: string | null;
  /** The id of the connection that reaches the account, or null while it is
   *  disconnected. */
  connection: string | null;
}

/** Body of `GET /api/connected-accounts`. */
export interface ListConnectedAccountsResult {
  accounts: ConnectedAccountEntry[];
}

/** Body of `PUT /api/connected-accounts/:platform/:accountId/agent`, which names the
 *  account itself. Null unlinks it. A disconnected account can be unlinked,
 *  but takes a new agent only once it is connected again, since its kind of
 *  connection decides whether it takes one. */
export type LinkConnectedAccountRequest = LinkAccountAgentRequest;

/** The connected account as it stands after a link by account. */
export interface LinkConnectedAccountResult {
  account: ConnectedAccountEntry;
}
