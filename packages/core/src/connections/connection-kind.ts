/**
 * A kind of connection as Rome reads through it: the address book and the
 * history a connection of the kind can answer. Vocabulary:
 * docs/domains/connections.md#connection-kind.
 *
 * Both are the kind's, not a connection's: the kind knows how to read them,
 * and the stores they read outlive any one connection, so a read answers with
 * no connection live. A read that had to wait for a live connection would make
 * every People read depend on whether the guardian's phone is reachable.
 */

import type { AddressBooks } from "../chats/accounts/account-fold.js";
import type { Accounts } from "../chats/accounts/accounts.js";
import type { AccountMessages, Messages } from "../chats/history/messages.js";
import { linkedInMessages } from "../chats/history/linkedin-messages.js";
import {
  WECHAT_USER_CHANNEL,
  wechatUserAccounts,
  wechatUserMessages,
} from "../chats/history/wechat-user-messages.js";
import { whatsAppMessages } from "../chats/history/whatsapp-messages.js";
import type { DrizzleDb } from "../db/index.js";
import type { WechatUserReader } from "./kinds/wechat-user/wechat-user.js";

export interface ConnectionKind {
  /** The kind's name, as stored rows spell it today: `whatsapp`, `linkedin`.
   *  Kept only as the lookup those rows need until they name an account by
   *  its platform and the platform's own id. */
  readonly name: string;

  /**
   * Who the kind's accounts can reach, or null where the platform gives Rome
   * no way to enumerate them. Null is the common case: a kind Rome only
   * receives on knows an address when a message arrives at it, and a caller
   * works from the addresses it already holds.
   */
  readonly accounts: Accounts | null;

  /**
   * What was said, as the kind can answer for it, or null where it can answer
   * nothing. A kind that holds the conversation as the platform has it
   * answers back past the point Rome started watching. Only a copy Rome keeps
   * answers `byAccount`.
   *
   * Null means what was said survives only in Rome's own transcript, which
   * belongs to no kind and answers for all of them.
   */
  readonly messages: Messages | null;
}

/**
 * The kinds that can answer a read, in the order they claim an account. A
 * kind that answers nothing holds no entry, which is the same answer as an
 * entry with both reads null.
 */
export type ConnectionKinds = readonly ConnectionKind[];

/**
 * Every kind with an address book or a history. WhatsApp's and LinkedIn's
 * read tables a sync fills; the personal WeChat kind reads the client's own
 * database. The address books arrive built rather than made here, so every
 * caller folds one instance of each.
 */
export function connectionKinds(deps: {
  db: DrizzleDb;
  whatsAppAccounts: Accounts;
  linkedInAccounts: Accounts;
  /** The personal WeChat reader, present only when that kind is enabled. */
  wechatUserReader?: WechatUserReader;
  /** Address books of other kinds, by the kind's name. */
  accounts?: Record<string, Accounts>;
}): ConnectionKind[] {
  const kinds: ConnectionKind[] = [
    { name: "whatsapp", accounts: deps.whatsAppAccounts, messages: whatsAppMessages(deps.db) },
    { name: "linkedin", accounts: deps.linkedInAccounts, messages: linkedInMessages(deps.db) },
  ];
  if (deps.wechatUserReader) {
    kinds.push({
      name: WECHAT_USER_CHANNEL,
      accounts: wechatUserAccounts(deps.wechatUserReader),
      messages: wechatUserMessages(deps.wechatUserReader),
    });
  }
  for (const [name, accounts] of Object.entries(deps.accounts ?? {})) {
    if (!kinds.some((kind) => kind.name === name)) kinds.push({ name, accounts, messages: null });
  }
  return kinds;
}

/** The kind named `name`, or null where none answers a read. */
export function kindNamed(kinds: ConnectionKinds, name: string): ConnectionKind | null {
  return kinds.find((kind) => kind.name === name) ?? null;
}

/**
 * Each kind's address book by the platform its accounts live on, for the
 * callers that fold every account at once. A book files an account under its
 * platform whichever kind mirrors it. Kinds with no address book are absent,
 * which is what a fold reads to fall back on the addresses it already holds.
 * Should two kinds on one platform both have one, the kind listed first
 * answers for it.
 */
export function addressBooks(
  kinds: ConnectionKinds,
  platformOfKind: (name: string) => string,
): AddressBooks {
  const books: Record<string, Accounts> = {};
  for (const kind of kinds) {
    const platform = platformOfKind(kind.name);
    if (kind.accounts && !books[platform]) books[platform] = kind.accounts;
  }
  return books;
}

/** The kinds' own stores that answer per-account reads, in the kinds' order.
 *  Rome's own transcript is not here: it belongs to no kind, and a read that
 *  wants it appends it behind these. */
export function messageStores(kinds: ConnectionKinds): AccountMessages[] {
  return kinds.flatMap((kind) => (kind.messages?.byAccount ? [kind.messages.byAccount] : []));
}
