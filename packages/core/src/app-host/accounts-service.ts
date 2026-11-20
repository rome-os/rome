/**
 * `ChannelsService`: Rome's accounts, and the channels they are, for app
 * actions. An action names an account by its platform and the platform's id
 * (`Account`), or a channel by its name. It sends and reads through the
 * service the same way in the main process and in a worker (where
 * `ChannelsServiceProxy` reaches this one over RPC).
 *
 * Connections are the service's own business. A channel is one presence, so
 * at most one Connection backs it, and nothing above the service names a
 * Connection.
 */

import type {
  Account,
  ChannelChatsPage,
  ChannelChatsQuery,
  ChannelMessage,
  ChannelMessageQuery,
  ChannelMessageSearch,
  ChannelSearchResult,
  ChannelSummary,
  ChannelsService,
  ChatId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import type { ConnectionRegistry } from "../connections/registry.js";
import { platformOf } from "../connections/platform.js";
import type { Connection } from "../connections/types.js";
import {
  AccountNotConnected,
  type Channel,
  type Channels,
} from "../chats/connected-accounts/connected-account.js";
import { sendThrough, type ChannelOf } from "../chats/connected-accounts/connection-ports.js";
import { withRemovedMembers } from "../lib/removed-members.js";
import { parseMessageCursor } from "@rome/api-types/message";
import { channelMessageCursor } from "../chats/history/messages.js";
import {
  accountLabel,
  isAccount,
  type RomeAccounts,
} from "../chats/connected-accounts/rome-accounts.js";

// TODO(0.8): remove, with the service's and the proxy's uses.
export const REMOVED_SERVICE_MEMBERS: Record<string, string> = {
  history:
    "ChannelsService.history was removed in @rome-os/app-runtime 0.7: read through query, which answers newest first",
};
// TODO(0.8): remove, with the service's and the proxy's uses.
export const REMOVED_SUMMARY_MEMBERS: Record<string, string> = {
  connectionIds:
    "ChannelSummary.connectionIds was removed in @rome-os/app-runtime 0.7: read sendable, and send without naming a Connection",
};

export interface ChannelsServiceDeps {
  /** The channel list, or undefined until it is built. It is built after the
   *  services that hand this one out, and until then `list` names only the
   *  channels a Connection backs, `send` works, and nothing reads messages. */
  channels: () => Channels | undefined;
  /** The Connections that back sending. */
  registry: Pick<ConnectionRegistry, "all">;
  /** Names the channel each Connection backs. A Connection it answers null
   *  for backs no channel and is skipped. */
  channelOf: ChannelOf;
  /** The platform a channel is an account on, or null where no record names
   *  one. A backed channel no record names reads its Connection's. */
  platformOf?: (channel: string) => string | null;
  /** Whether a connection kind's talker searches its messages, as the kind
   *  declares it. Absent, a channel is searchable only while its talker is
   *  live. */
  searches?: (connectionKind: string) => boolean;
  /** Channels Rome serves itself, which no Connection backs, such as webchat.
   *  Each sends through its own port, before the channel list is built too. */
  own?: readonly Channel[];
  /** Rome's accounts and the Connections that reach them. Absent, the service
   *  names no account and takes only a channel's name. */
  accounts?: RomeAccounts;
}

/** How many chats a listing answers when it names no limit, and at most. */
const CHATS_LIMIT = 100;
const CHATS_LIMIT_MAX = 200;

/** How many matches a search answers when it names no limit, and at most. */
const SEARCH_LIMIT = 20;
const SEARCH_LIMIT_MAX = 100;

/** Every Connection that can talk, whether or not it is unlocked now. */
function talking(registry: Pick<ConnectionRegistry, "all">): Connection[] {
  return registry.all().filter((connection) => connection.status().chat.state !== "unsupported");
}

/** The Connection backing a channel, or undefined when none does. A channel
 *  is one presence, so at most one Connection backs it. */
export function backingConnection(
  registry: Pick<ConnectionRegistry, "all">,
  channel: string,
  channelOf: ChannelOf,
): Connection | undefined {
  return talking(registry).find((connection) => channelOf(connection) === channel);
}

/** The email Connection inbound mail goes to: the one backing the `email`
 *  channel, or else the oldest email Connection that can talk. An email
 *  account connected after another was removed has its own record, under an
 *  opaque id, so it is found by its connection kind, not by the channel name. */
export function emailConnection(
  registry: Pick<ConnectionRegistry, "all">,
  channelOf: ChannelOf,
): Connection | undefined {
  const emails = talking(registry).filter((connection) => connection.connectionKind === "email");
  return emails.find((connection) => channelOf(connection) === "email") ?? emails[0];
}

/** An account no Connection of Rome's reaches, so nothing sends as it or reads
 *  what was said on it. */
export class AccountNotHeld extends Error {
  constructor(readonly account: Account) {
    super(`No connection reaches account "${accountLabel(account)}"`);
    this.name = "AccountNotHeld";
  }
}

export function createChannelsService(deps: ChannelsServiceDeps): ChannelsService {
  const find = (name: string) => deps.channels()?.find((channel) => channel.name === name);
  const accountOf = (connection: Connection) => deps.accounts?.accountOf(connection.id) ?? null;

  /** The Connection that reaches `account`, among those that can talk. */
  function holding(account: Account): Connection {
    const id = deps.accounts?.holderOf(account);
    const connection = id ? talking(deps.registry).find((each) => each.id === id) : undefined;
    if (!connection) throw new AccountNotHeld(account);
    return connection;
  }

  /** The channel `target` names, and the account it is where one is known. */
  function resolve(target: Account | string): { channel: string; account: Account | null } {
    if (!isAccount(target)) {
      const backing = backingConnection(deps.registry, target, deps.channelOf);
      return { channel: target, account: backing ? accountOf(backing) : null };
    }
    const channel = deps.channelOf(holding(target));
    if (channel === null) throw new AccountNotHeld(target);
    return { channel, account: { platform: target.platform, id: target.id } };
  }

  async function query(
    target: Account | string,
    read: ChannelMessageQuery = {},
  ): Promise<ChannelMessage[]> {
    const { channel, account } = resolve(target);
    const messages = find(channel)?.messages;
    if (!messages) throw new Error(`Channel "${channel}" reads no messages`);
    const { after: cursor, ...rest } = read;
    // Paging walks back through one chat; across every chat it has no use.
    if (cursor !== undefined && !rest.chatId)
      throw new Error("A query after a cursor names a chat");
    if ((rest.olderThan !== undefined || rest.newerThan !== undefined) && !rest.chatId)
      throw new Error("A query by message id names a chat");
    if (rest.newerThan !== undefined && (rest.olderThan !== undefined || cursor !== undefined))
      throw new Error("A query reads newer than a message, or older, not both");
    if (rest.olderThan !== undefined && cursor !== undefined)
      throw new Error("A query reads older than a message id or after a cursor, not both");
    // Only a store read live from the platform orders by the platform's ids.
    if (
      !messages.live &&
      (rest.until !== undefined || rest.olderThan !== undefined || rest.newerThan !== undefined)
    )
      throw new Error(
        `Channel "${channel}" reads no messages by message id or until a time; use since and after`,
      );
    const after = cursor === undefined ? undefined : parseMessageCursor(cursor);
    if (after === null) throw new Error(`Invalid message cursor: ${cursor}`);
    const page = await messages.query({ ...rest, ...(after ? { after } : {}) });
    return page.map((message) => ({
      ...message,
      ...(account ? { account } : {}),
      cursor: channelMessageCursor(message),
    }));
  }

  /** The Connection backing `target`'s channel, and the account it is. */
  function backing(target: Account | string): {
    channel: string;
    account: Account | null;
    connection: Connection;
  } {
    if (isAccount(target)) {
      const connection = holding(target);
      const channel = deps.channelOf(connection);
      if (channel === null) throw new AccountNotHeld(target);
      return { channel, account: { platform: target.platform, id: target.id }, connection };
    }
    const connection = backingConnection(deps.registry, target, deps.channelOf);
    if (!connection) throw new AccountNotConnected(target);
    return { channel: target, account: accountOf(connection), connection };
  }

  async function search(
    target: Account | string,
    { text, chatId, limit }: ChannelMessageSearch,
  ): Promise<ChannelSearchResult> {
    const { channel, account, connection } = backing(target);
    if (!text.trim()) throw new Error("A search names the text it looks for");
    const capped = Math.min(Math.max(1, Math.floor(limit ?? SEARCH_LIMIT)), SEARCH_LIMIT_MAX);
    const found = connection.withTalker((talker) =>
      talker.search?.search({ text, ...(chatId ? { chatId } : {}), limit: capped }),
    );
    if (!found) {
      const state = connection.status().chat.state;
      throw new Error(
        state === "unlocked"
          ? `Channel "${channel}" searches no messages`
          : `Channel "${channel}" cannot search now: its connection is ${state}`,
      );
    }
    const { messages, coverage } = await found;
    return {
      messages: messages.map((message) => ({
        ...message,
        channel,
        ...(account ? { account } : {}),
        cursor: channelMessageCursor(message),
      })),
      coverage,
    };
  }

  async function chats(
    target: Account | string,
    { query, limit, cursor }: ChannelChatsQuery = {},
  ): Promise<ChannelChatsPage> {
    const { channel, connection } = backing(target);
    const capped = Math.min(Math.max(1, Math.floor(limit ?? CHATS_LIMIT)), CHATS_LIMIT_MAX);
    // The connection's own listing, so its paging holds and a refusal from the
    // platform comes back as one.
    const listed = connection.withTalker((talker) =>
      talker.directory?.listConversations({
        limit: capped,
        includeTopics: false,
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!listed) {
      const state = connection.status().chat.state;
      throw new Error(
        state === "unlocked"
          ? `Channel "${channel}" lists no chats`
          : `Channel "${channel}" cannot list chats now: its connection is ${state}`,
      );
    }
    const page = await listed;
    return {
      chats: page.conversations.map((chat) => ({
        chatId: chat.ref.chatId,
        name: chat.displayName,
        kind: chat.kind,
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  return withRemovedMembers<ChannelsService>(
    {
      async list(): Promise<ChannelSummary[]> {
        const summaries = new Map<string, ChannelSummary>();
        for (const connection of talking(deps.registry)) {
          const name = deps.channelOf(connection);
          if (name === null) continue;
          const platform = deps.platformOf?.(name) ?? platformOf(connection.connectionKind);
          const account = accountOf(connection);
          // Declared, so a locked connection still names what it is.
          const searchable =
            deps.searches?.(connection.connectionKind) ??
            connection.withTalker((talker) => talker.search !== undefined);
          summaries.set(name, {
            name,
            ...(account ? { account } : {}),
            platform,
            sendable: true,
            ...(searchable ? { searchable } : {}),
          });
        }
        for (const channel of deps.own ?? []) {
          const platform = deps.platformOf?.(channel.name) ?? platformOf(channel.name);
          summaries.set(channel.name, { name: channel.name, platform, sendable: !!channel.send });
        }
        for (const channel of deps.channels() ?? []) {
          if (!summaries.has(channel.name)) {
            const platform = deps.platformOf?.(channel.name) ?? undefined;
            summaries.set(channel.name, {
              name: channel.name,
              ...(platform ? { platform } : {}),
              sendable: false,
            });
          }
        }
        return [...summaries.values()].map((summary) =>
          withRemovedMembers(summary, REMOVED_SUMMARY_MEMBERS),
        );
      },

      async send(
        target: Account | string,
        chatId: ChatId,
        message: OutgoingMessage,
      ): Promise<MessageReceipt> {
        if (isAccount(target)) {
          return sendThrough(holding(target), chatId, message);
        }
        const channel = target;
        const own = deps.own?.find((candidate) => candidate.name === channel)?.send;
        if (own) return own.send(chatId, message);
        const backing = backingConnection(deps.registry, channel, deps.channelOf);
        if (!backing) throw new Error(`No Talk connection registered for "${channel}"`);
        return sendThrough(backing, chatId, message);
      },

      query,
      search,
      chats,
    },
    REMOVED_SERVICE_MEMBERS,
  );
}
