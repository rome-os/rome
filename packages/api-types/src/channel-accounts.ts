/**
 * The wire shapes of accounts and the agents linked to them. Screens call a
 * channel an account. Vocabulary: docs/domains/chats.md#account.
 */

/**
 * The account fields of one entry in `GET /api/connections`. Each is optional
 * because a core that predates several accounts omits them, and the dashboard
 * renders as before when one is absent.
 */
export interface ConnectionAccountFields {
  /** Id of the channel this Connection backs. The first channel of a service
   *  is named after it (`feishu`), and later ones get an opaque id. Null for
   *  placeholders and services without a Talk. */
  channel?: string | null;
  /** Platform of the channel this Connection backs (`telegram`, `lark`), as
   *  `ChannelAccount.platform` names it. Null where `channel` is null. */
  platform?: string | null;
  /** Canonical id of the agent linked to this account (`sales:agent`,
   *  `core:main`), or null when none is, which leaves the account silent.
   *  Absent for placeholders and for a service that takes no link. */
  agent?: string | null;
  /** Whether the service offers "add another account". */
  severalAccounts?: boolean;
}

/** One account, as `GET /api/channels/accounts` lists it. */
export interface ChannelAccount {
  /** The channel's id. */
  id: string;
  /** The kind of connection backing the account, such as `telegram_user`. */
  connectionKind: string;
  /** @deprecated The kind of connection under its old name. Read
   *  `connectionKind`. */
  service: string;
  platform: string;
  /** The Connection backing the account, or null once it was deleted. */
  connectionId: string | null;
  /** Canonical id of the account's agent, or null when the account is silent. */
  agent: string | null;
}

/** Body of `PUT /api/channels/accounts/:id/agent`. Null unlinks the account,
 *  which leaves it silent. */
export interface LinkAccountAgentRequest {
  agent: string | null;
}

/** The account as it stands after the link. A link changes no other account:
 *  an agent may be linked to any number of accounts, several on one platform
 *  included. */
export interface LinkAccountAgentResult {
  account: ChannelAccount;
}
