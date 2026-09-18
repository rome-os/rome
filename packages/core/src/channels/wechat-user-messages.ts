// The personal WeChat account as a people-timeline source: an address book of
// the guardian's own contacts and a live message store over them. Channel
// contract: channel.ts; the store contract and its ordering law: messages.ts.
//
// Unlike the LinkedIn and WhatsApp stores, which read a table a background sync
// fills, this reads the client's own SQLite live through the reader. The store
// is local to the container and answers in milliseconds, so a Rome-side mirror
// would only add staleness — the client's database is the mirror. Everything
// here is read-only; the connection cannot send.
//
// Direct threads only reach a person's timeline (timeline-sources.ts), so the
// address book lists one-to-one contacts and never groups: a group is addressed
// by the group, not by a person on it.

import { compareMessages, isAfterMessageCursor, type Message } from "@rome/api-types/message";
import type { Account, AccountId, Accounts } from "./accounts.js";
import type { ConversationRead, MessageAccount, MessageRead, Messages } from "./messages.js";
import {
  isWechatUserSessionRejected,
  WechatUserStorePending,
  type WechatUserConversation,
  type WechatUserMessage,
  type WechatUserReader,
} from "./wechat-user.js";

/** The channel name every stored WeChat-account row spells, matching the
 *  connection service and the person mappings that link to it. */
export const WECHAT_USER_CHANNEL = "wechat_user";

/** A bounded window for one live read. The reader ranks newest-first and has no
 *  native cursor, so a page is taken locally over a bounded fetch — the same
 *  bargain the connection's own directory read makes. */
const WINDOW_CAP = 500;

function windowSize(limit: number): number {
  return Math.min(Math.max(limit, 1) * 4, WINDOW_CAP);
}

/** Project a reader message onto the timeline's message shape. `ref` is the
 *  reader's own id, already qualified as `<conversation>:<localId>` and so
 *  unique across the account's timeline. */
function toMessage(message: WechatUserMessage): Message {
  return {
    source: WECHAT_USER_CHANNEL,
    timestamp: message.timestamp,
    body: message.text || null,
    direction: message.isSelf ? "outbound" : "inbound",
    ref: message.id,
  };
}

/** The direct-contact addresses (wxids) a set of accounts names on this channel. */
function directAddresses(accounts: readonly MessageAccount[]): string[] {
  return [
    ...new Set(
      accounts
        .filter((account) => account.channel === WECHAT_USER_CHANNEL)
        .flatMap((account) => account.addresses),
    ),
  ];
}

/**
 * `Messages` over the personal WeChat store, read live through the reader.
 *
 * Paging without a native cursor: the reader answers the newest messages
 * at-or-before a timestamp, so a page after a cursor fetches a bounded window
 * ending at the cursor's second, including every tie, and drops what the cursor covered
 * ({@link isAfterMessageCursor}). `compareMessages` is the one ranking both a
 * store and a person's timeline cut, so the local sort matches every consumer.
 */
export function wechatUserMessages(reader: WechatUserReader): Messages {
  async function windowFor(
    addresses: readonly string[],
    opts: { before?: Message | null; limit: number },
  ): Promise<Message[]> {
    const before = opts.before ? new Date(opts.before.timestamp * 1000) : undefined;
    const perConversation = await Promise.all(
      addresses.map((conversationId) =>
        reader
          .messages({
            conversationId,
            ...(before ? { before } : {}),
            limit: opts.limit,
            includeBoundaryTies: true,
          })
          .then((messages) => messages.map(toMessage))
          .catch(() => [] as Message[]),
      ),
    );
    return perConversation.flat().sort(compareMessages);
  }

  function page(all: Message[], after: Message | null | undefined, limit: number): Message[] {
    const filtered = after ? all.filter((message) => isAfterMessageCursor(message, after)) : all;
    return filtered.slice(0, Math.max(limit, 0));
  }

  return {
    async read({ accounts, after, limit }: MessageRead): Promise<Message[]> {
      const addresses = directAddresses(accounts);
      if (addresses.length === 0) return [];
      const all = await windowFor(addresses, { before: after ?? null, limit: windowSize(limit) });
      return page(all, after, limit);
    },

    async count(accounts: readonly MessageAccount[]): Promise<number> {
      const addresses = directAddresses(accounts);
      if (addresses.length === 0) return 0;
      const counts = await Promise.all(
        addresses.map((conversationId) => reader.count(conversationId).catch(() => 0)),
      );
      return counts.reduce((total, n) => total + n, 0);
    },

    async latest(accounts: readonly MessageAccount[]): Promise<Message | null> {
      const addresses = directAddresses(accounts);
      if (addresses.length === 0) return null;
      const newest = await windowFor(addresses, { limit: 1 });
      return newest[0] ?? null;
    },

    async readConversation({ conversation, after, limit }: ConversationRead): Promise<Message[]> {
      if (conversation.channel !== WECHAT_USER_CHANNEL) return [];
      const before = after ? new Date(after.timestamp * 1000) : undefined;
      const messages = await reader
        .messages({
          conversationId: conversation.id,
          includeBoundaryTies: true,
          ...(before ? { before } : {}),
          limit: windowSize(limit),
        })
        .then((rows) => rows.map(toMessage).sort(compareMessages))
        .catch(() => [] as Message[]);
      return page(messages, after, limit);
    },
  };
}

/** One WeChat contact as an account: its wxid is the id and its only address,
 *  its display name is the platform's, and the wxid is also a searchable
 *  identifier. Groups are not accounts and are filtered out by the caller. */
function toAccount(conversation: WechatUserConversation): Account {
  return {
    id: conversation.id as AccountId,
    addresses: [conversation.id],
    name: conversation.name || null,
    identifiers: { "wechat:wxid": conversation.id },
  };
}

/**
 * The guardian's own WeChat contacts as an address book.
 *
 * The reader enumerates the conversations the account holds; the direct ones
 * are its contacts. A wxid is stable and unique per account, and the only
 * address a contact is reached at, so the four account invariants hold with the
 * wxid as the id: one account per wxid, stable across reads, opaque to callers,
 * and every address a message arrives on (the wxid) resolves to it.
 */
export function wechatUserAccounts(reader: WechatUserReader): Accounts {
  async function conversations(input: { query?: string; limit: number }) {
    try {
      return await reader.conversations(input);
    } catch (error) {
      if (isWechatUserSessionRejected(error) || error instanceof WechatUserStorePending) return [];
      throw error;
    }
  }
  return {
    async listAccounts({ query, limit }): Promise<{ accounts: Account[] }> {
      const rows = await conversations({
        ...(query ? { query } : {}),
        limit,
      });
      return {
        accounts: rows.filter((conversation) => !conversation.isGroup).map(toAccount),
      };
    },

    async resolve(address: string): Promise<Account | null> {
      // The address is a wxid; find the direct conversation it names. A bounded
      // scan, since the reader has no by-id contact read — enough to cover an
      // account's own contacts, which is all a message can arrive from.
      const rows = await conversations({ limit: WINDOW_CAP });
      const match = rows.find(
        (conversation) => conversation.id === address && !conversation.isGroup,
      );
      return match ? toAccount(match) : null;
    },
  };
}
