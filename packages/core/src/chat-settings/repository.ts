// Reply rules, kept on each of Rome's speakers. Vocabulary:
// docs/domains/participation.md#speaker and docs/domains/chats.md#chat.

import { and, asc, desc, eq, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import type { Account, ChatDescriptor, ChatId, StoredChatSettings } from "@rome-os/app-runtime";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { chatIdsOn, type ChatRepository } from "../chats/storage/chat-repository.js";
import type { Chat, ChatKind } from "../chats/storage/chat.js";
import { placeIn, type ChatKey, type ChatRef } from "../chats/storage/place.js";
import { startChannelChat } from "../connections/channel-chat.js";
import { addressOf, type ChatAdapters, kindNamedBy } from "../connections/chat-adapter.js";
import type { ChatAddresses } from "../connections/chat-addresses.js";
import { chatMessages, chats, romeAgentMessages, romeSessions } from "../db/schema/system.js";
import { channelChatId, isChannelConversation } from "../db/session-kind.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../webchat/constants.js";

type SpeakerRow = typeof romeSessions.$inferSelect;

/** A speaker as chat settings read it: its row, the kind of place it stands
 *  in (a topic when it stands in a thread), the name of that place, the
 *  channel it speaks through and the platform address that channel reaches
 *  it at. Channel and address are null when no channel is its account. */
export type StoredChatRow = SpeakerRow & {
  kind: "dm" | "group" | "topic";
  channel: string | null;
  /** The chat's name, or the row's own for a thread, null while the
   *  platform has given none. */
  placeName: string | null;
  address: ChatId | null;
};

export interface ChatSettingsRepositoryDeps {
  /** Where a chat is started when a rule is set before anything was said. */
  chats: Pick<ChatRepository, "start" | "rename" | "byKey" | "find">;
  /** The chat adapters, which name the chat at an address and the channel
   *  that is one of Rome's accounts. */
  adapters: Pick<
    ChatAdapters,
    "chatAt" | "accountOn" | "knownAccountOn" | "channelOf" | "addressAt" | "openedDirectMessageAt"
  >;
  /** Where each of Rome's accounts reaches its chats, read once per account
   *  in a listing. */
  addresses: Pick<ChatAddresses, "addressesOf">;
}

/**
 * Reply rules, kept on each of Rome's speakers (`rome_sessions.channel_settings`).
 * A group's rule is the group's whichever of Rome's accounts set it, so it is
 * written to every speaker in the chat; each speaker keeps its own routing
 * marker. A speaker is found by its chat and Rome's account, never by the
 * channel's name.
 */
export class ChatSettingsRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly deps: ChatSettingsRepositoryDeps,
  ) {}

  /** The account `channel` speaks as. Throws for a channel whose record
   *  knows none, which is not active. */
  private accountOn(channel: string): Account {
    const account = this.deps.adapters.knownAccountOn(channel);
    if (!account) throw new Error(`Channel ${channel} knows no account, so it is not active`);
    return account;
  }

  /** The adapter's key for the chat at address `chatId` as `channel`'s
   *  account sees it. */
  private keyOf(channel: string, chatId: ChatId, kind: ChatDescriptor["kind"]): ChatKey {
    return this.deps.adapters.chatAt(channel, chatId, kind === "dm" ? "dm" : "group");
  }

  /** The chat at address `chatId` as `channel`'s account sees it, or null
   *  when Rome holds none there. */
  private chatOf(channel: string, chatId: ChatId, kind: ChatDescriptor["kind"]): ChatRef | null {
    return this.deps.chats.byKey(this.keyOf(channel, chatId, kind))?.ref ?? null;
  }

  /**
   * The speaker `channel`'s account holds at address `address`: in the group
   * there, else the direct message there, else the thread the address names.
   * None for a channel that knows no account.
   */
  private speakerAt(
    exec: DrizzleDb | DrizzleTx,
    channel: string,
    address: ChatId,
  ): SpeakerRow | undefined {
    const account = this.deps.adapters.knownAccountOn(channel);
    if (!account) return undefined;
    const first = (reached: string, ...where: SQL[]) =>
      exec
        .select()
        .from(romeSessions)
        .where(and(isChannelConversation, eq(romeSessions.accountId, account.id), ...where))
        // The session messages through `channel` reach there, when the
        // account holds more than one, as after a reconnect, or at a direct
        // message it reached at another address before.
        .orderBy(
          desc(sql`${romeSessions.id} = ${reached}`),
          desc(sql`${romeSessions.id} = ${channelChatId(channel, address)}`),
          asc(romeSessions.createdAt),
          asc(romeSessions.id),
        )
        .limit(1)
        .get();
    for (const kind of ["group", "dm"] as const) {
      const chat = this.chatOf(channel, address, kind);
      const row =
        chat &&
        first(
          channelChatId(channel, this.reachedAt(channel, chat, address)),
          eq(romeSessions.chatId, chat.id),
          isNull(romeSessions.threadId),
        );
      if (row) return row;
    }
    return first(
      channelChatId(channel, address),
      eq(romeSessions.threadId, address),
      sql`${romeSessions.chatId} in ${chatIdsOn(account.platform)}`,
    );
  }

  /** The address messages through `channel` reach `chat` at, which Rome
   *  holds at `address`. A direct message is reached at the address its
   *  platform last placed it, which an address the account reached it at
   *  before, as a person's id, is not. */
  private reachedAt(channel: string, chat: ChatRef, address: ChatId): ChatId {
    if (this.deps.chats.find(chat.id)?.kind !== "dm") return address;
    return this.deps.adapters.addressAt(channel, placeIn(chat));
  }

  /** The channel the speaker `row` speaks through: the one that is its
   *  account on its chat's platform, or null when none is. */
  private channelOf(row: SpeakerRow): string | null {
    if (!row.chatPlatform || !row.accountId) return null;
    return this.deps.adapters.channelOf({ platform: row.chatPlatform, id: row.accountId });
  }

  /** Speaker `row` with the kind and name of the place it stands in, the
   *  channel it speaks through, and its address. `seen` holds the chats and
   *  channels already read, across the rows of one listing. */
  private stored(row: SpeakerRow, seen: StoredLookups = newLookups()): StoredChatRow {
    let chat: Chat | null = null;
    if (row.chatId) {
      if (!seen.chats.has(row.chatId)) seen.chats.set(row.chatId, this.deps.chats.find(row.chatId));
      chat = seen.chats.get(row.chatId) ?? null;
    }
    const kind = row.threadId !== null ? "topic" : chat?.kind === "dm" ? "dm" : "group";
    const speaking = `${row.chatPlatform}\0${row.accountId}`;
    if (!seen.channels.has(speaking)) seen.channels.set(speaking, this.channelOf(row));
    const channel = seen.channels.get(speaking) ?? null;
    // Where the channel reaches the place, as `ChatAdapters.addressAt` reads
    // it: a thread at its own address, a chat where the account last heard
    // it, else at its key. Read from the account's addresses, once a listing.
    let address: ChatId | null = null;
    if (chat && channel && row.accountId) {
      if (row.threadId !== null) {
        address = row.threadId as ChatId;
      } else {
        if (!seen.addresses.has(speaking)) {
          seen.addresses.set(
            speaking,
            this.deps.addresses.addressesOf({ platform: chat.ref.platform, id: row.accountId }),
          );
        }
        const key = { platform: chat.ref.platform, externalId: chat.key as ChatId };
        address = (seen.addresses.get(speaking)?.get(chat.key) ?? addressOf(key)) as ChatId;
      }
    }
    const placeName = row.threadId !== null ? row.name : (chat?.name ?? null);
    return { ...row, kind, channel, placeName, address };
  }

  /** Speaker `sessionId`, whether or not a channel is its account now. */
  byId(sessionId: string): StoredChatRow | null {
    const row = this.db
      .select()
      .from(romeSessions)
      .where(and(isChannelConversation, eq(romeSessions.id, sessionId)))
      .get();
    return row ? this.stored(row) : null;
  }

  find(channel: string, chatId: ChatId): StoredChatRow | null {
    const row = this.speakerAt(this.db, channel, chatId);
    return row ? this.stored(row) : null;
  }

  listKnown(input: { channel?: string; query?: string }): StoredChatRow[] {
    const predicates = [isChannelConversation];
    if (input.channel) {
      // The channel's speakers: its account's, in chats on its platform.
      const account = this.deps.adapters.knownAccountOn(input.channel);
      if (!account) return [];
      predicates.push(
        eq(romeSessions.accountId, account.id),
        sql`${romeSessions.chatId} in ${chatIdsOn(account.platform)}`,
      );
    }
    if (input.query?.trim()) {
      // The name a listing shows: the chat's, or a thread's own.
      const pattern = `%${input.query.trim()}%`;
      predicates.push(
        or(
          sql`${romeSessions.chatId} in (SELECT ${chats.id} FROM ${chats} WHERE ${chats.name} LIKE ${pattern})`,
          and(isNotNull(romeSessions.threadId), like(romeSessions.name, pattern)),
        )!,
      );
    }
    const rows = this.db
      .select()
      .from(romeSessions)
      .where(and(...predicates))
      .orderBy(asc(romeSessions.accountId), asc(romeSessions.name))
      .all();
    const seen = newLookups();
    return rows.map((row) => this.stored(row, seen));
  }

  /** The reply rule of the chat at `chatId` as the account `channel` speaks
   *  as sees it: the group's, whichever of Rome's accounts set it, or the
   *  account's own direct message's. An address the account holds no
   *  speaker at reads a group's rule only when `kind` names a group or
   *  channel. The routing marker is the account's own speaker's. Null when
   *  none is set. */
  ruleOf(
    channel: string,
    chatId: ChatId,
    kind: ChatDescriptor["kind"] | null,
  ): StoredChatSettings | null {
    const own = this.speakerAt(this.db, channel, chatId);
    if (own === undefined && !isShared(kind)) return null;
    if (!isShared(kind) && (own === undefined || this.stored(own).kind !== "group")) {
      return own ? this.directRuleOf(own) : null;
    }
    if (!this.deps.adapters.knownAccountOn(channel)) return own?.channelSettings ?? null;
    // The group's rule is the newest any of Rome's speakers there holds,
    // whichever of them set it.
    const chat = this.chatOf(channel, chatId, "group");
    if (!chat) return own?.channelSettings ?? null;
    const held = this.db
      .select({ settings: romeSessions.channelSettings })
      .from(romeSessions)
      .where(
        and(
          eq(romeSessions.chatId, chat.id),
          isNull(romeSessions.threadId),
          isNotNull(romeSessions.channelSettings),
        ),
      )
      .all()
      .map((row) => row.settings as StoredChatSettings)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const rule = held[0] ?? null;
    return withRoutingOf(own?.channelSettings ?? null, rule && withoutRouting(rule));
  }

  /** The rule of the direct message or thread speaker `own` stands in: in a
   *  direct message, the newest its account holds there, as one set at an
   *  address the account reached it at before its platform placed it at
   *  another. */
  private directRuleOf(own: SpeakerRow): StoredChatSettings | null {
    if (own.threadId !== null || own.chatId === null || own.accountId === null) {
      return own.channelSettings ?? null;
    }
    const held = this.db
      .select({ settings: romeSessions.channelSettings })
      .from(romeSessions)
      .where(
        and(
          isChannelConversation,
          eq(romeSessions.chatId, own.chatId),
          isNull(romeSessions.threadId),
          eq(romeSessions.accountId, own.accountId),
          isNotNull(romeSessions.channelSettings),
        ),
      )
      .all()
      .map((row) => row.settings as StoredChatSettings)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return held[0] ?? null;
  }

  /** The kind platform address `chatId` names by itself on `channel`'s
   *  platform ({@link kindNamedBy}), or null where it names none or the
   *  channel knows no account. */
  namedKind(channel: string, chatId: ChatId): "group" | "dm" | null {
    const account = this.deps.adapters.knownAccountOn(channel);
    return account ? kindNamedBy(account.platform, chatId) : null;
  }

  /** The kind of the chat Rome holds at address `chatId` on `channel`'s
   *  platform, through any of its accounts, whose kind is then fixed; else
   *  null. An address bound to a direct message holds that one, though asked
   *  for a group. */
  heldKind(channel: string, chatId: ChatId): ChatKind | null {
    if (!this.deps.adapters.knownAccountOn(channel)) return null;
    return this.deps.chats.byKey(this.keyOf(channel, chatId, "group"))?.kind ?? null;
  }

  /** The platform channel `channel`'s account lives on. */
  platformOf(channel: string): string {
    return this.accountOn(channel).platform;
  }

  /** Whether anything was said where session `sessionId` stands: a message
   *  in its chat and thread, or a row of its own. */
  hasMessageHistory(sessionId: string): boolean {
    return (
      this.db.all(sql`
        SELECT 1 FROM ${romeSessions} s
        WHERE s.id = ${sessionId} AND (
          EXISTS (SELECT 1 FROM ${chatMessages} m
            WHERE m.chat_id = s.chat_id AND m.thread_id IS s.thread_id)
          OR EXISTS (SELECT 1 FROM ${romeAgentMessages} r WHERE r.session_id = s.id))
      `).length > 0
    );
  }

  /**
   * Set the reply rule of the conversation `descriptor` names, through the
   * account `channel` speaks as, starting the chat and the account's speaker
   * there when Rome holds none yet, and bind the speaker to `agentName`
   * unless that is undefined. One SQLite transaction. Callers serialize by
   * address before entering this method.
   */
  mutate(
    descriptor: ChatDescriptor,
    channel: string,
    input: {
      settings: StoredChatSettings | null;
      agentName: string | null | undefined;
      /** False when `descriptor.kind` is only a guess, made for an address
       *  its platform has never described. The rule then stays the
       *  account's own, and reaches no other speaker in a group. */
      kindKnown?: boolean;
    },
  ): void {
    // A webchat address is a guardian chat, which has no conversation settings.
    if (descriptor.connectionKind === "webchat") {
      throw new Error("Webchat chats have no conversation settings");
    }
    if (descriptor.parent) {
      this.mutateThread(descriptor, channel, input);
      return;
    }
    // Immediate: it reads before it writes, and another connection may
    // commit in between.
    this.db.transaction(
      (tx) => {
        const kindKnown = input.kindKnown ?? true;
        const via = this.accountOn(channel);
        const existing = this.speakerAt(tx, channel, descriptor.ref.chatId);
        const chat =
          (existing?.chatId ? this.deps.chats.find(existing.chatId)?.ref : null) ??
          this.startChat(descriptor, channel, kindKnown);
        // An address standing in for a name the platform has not given is no
        // name: the first message there names the chat.
        const placeholder = isPlaceholderName(channel, descriptor);
        if (!placeholder) this.deps.chats.rename(chat, descriptor.displayName);
        // The session messages through `channel` reach the chat at: its id
        // and its stored address name the same address, as the session the
        // first message there opens would.
        const at = this.reachedAt(channel, chat, descriptor.ref.chatId);
        const id = channelChatId(channel, at);
        const name = placeholder ? at : descriptor.displayName;
        const now = new Date();
        // A speaker first placed here starts a second before now, so the first
        // message, heard within the second, is one it has not seen. Where the
        // account already spoke here, as a send that opened no session, it
        // starts before that message instead, so it reads what it said, as
        // `ensureChannelChat` places one.
        const firstOwn = tx.all<{ at: number | null }>(sql`
          SELECT min(said_at) AS at FROM chat_messages
          WHERE chat_id = ${chat.id} AND thread_id IS NULL AND sender_account_id = ${via.id}
        `)[0]?.at;
        const startSecond = Math.min(
          Math.floor(now.getTime() / 1000),
          firstOwn ?? Number.POSITIVE_INFINITY,
        );
        const placedAt = new Date((startSecond - 1) * 1000);
        // The legacy source columns are still written for readers that have
        // not moved to the speaker's chat and account.
        const sourceThreadType = !kindKnown
          ? null
          : descriptor.kind === "dm"
            ? "private"
            : descriptor.kind;
        tx.insert(romeSessions)
          .values({
            id,
            name,
            personaId: null,
            projectName: DEFAULT_WEBCHAT_PROJECT_NAME,
            projectPath: null,
            largeModelSelection: null,
            agentName: null,
            type: "channel",
            sourceChannel: channel,
            sourceThreadId: at,
            sourceThreadName: name,
            sourceThreadType,
            chatId: chat.id,
            chatPlatform: chat.platform,
            accountId: via.id,
            createdAt: placedAt,
            activityAt: now,
            lastSeenActivityAt: null,
          })
          .onConflictDoNothing({ target: romeSessions.id })
          .run();
        tx.update(romeSessions)
          .set({
            // A placeholder leaves the name the session has.
            ...(placeholder ? {} : { name }),
            ...(sourceThreadType === null ? {} : { sourceThreadType }),
            // The row is this account's speaker in this chat. One stored
            // before it stood in a chat stands here now, and one left by the
            // account the channel was paired as before moves here, as the
            // first message after a re-pairing moves it.
            createdAt: sql`CASE WHEN ${romeSessions.chatId} IS NULL AND ${romeSessions.createdAt} >= ${startSecond}
              THEN ${startSecond - 1} ELSE ${romeSessions.createdAt} END`,
            chatId: chat.id,
            chatPlatform: chat.platform,
            accountId: via.id,
            // The routing marker is this account's alone, so only its row holds it.
            channelSettings: input.settings,
            ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
          })
          .where(eq(romeSessions.id, id))
          .run();
        // A direct message's rule is its account's there: a speaker the
        // account stood in it at another address takes it too, so a rule
        // cleared here is cleared there.
        if (this.deps.chats.find(chat.id)?.kind === "dm") {
          tx.update(romeSessions)
            .set({ channelSettings: input.settings })
            .where(
              and(
                eq(romeSessions.chatId, chat.id),
                isNull(romeSessions.threadId),
                eq(romeSessions.accountId, via.id),
              ),
            )
            .run();
        }
        // A group's rule is the group's: every other speaker there takes it,
        // keeping its own routing marker.
        if (isShared(descriptor.kind) && kindKnown) {
          const rule = input.settings && withoutRouting(input.settings);
          const others = tx
            .select({ id: romeSessions.id, channelSettings: romeSessions.channelSettings })
            .from(romeSessions)
            .where(and(eq(romeSessions.chatId, chat.id), isNull(romeSessions.threadId)))
            .all()
            .filter((row) => row.id !== id);
          for (const row of others) {
            tx.update(romeSessions)
              .set({ channelSettings: withRoutingOf(row.channelSettings, rule) })
              .where(eq(romeSessions.id, row.id))
              .run();
          }
        }
      },
      { behavior: "immediate" },
    );
  }

  /**
   * The chat at the address `descriptor` names, started as an incoming
   * message there would start it ({@link startChannelChat}): of the kind the
   * address names where it names one, else of the kind `descriptor` states.
   * Refuses when that kind is only a guess (`kindKnown` false) and the
   * address names none, since a chat's kind never changes and a wrong one
   * would hold the session the first message opens.
   */
  private startChat(descriptor: ChatDescriptor, channel: string, kindKnown: boolean): ChatRef {
    const address = descriptor.ref.chatId;
    if (!kindKnown && kindNamedBy(this.accountOn(channel).platform, address) === null) {
      throw new Error(
        `Rome cannot tell whether the chat at ${address} on ${channel} is a group or a direct message: no message there has reached Rome and its platform has not listed it. Its rule can be set once either happens`,
      );
    }
    return startChannelChat(this.deps, {
      channel,
      threadId: address,
      ...(isPlaceholderName(channel, descriptor) ? {} : { threadName: descriptor.displayName }),
      ...(kindKnown ? { threadType: descriptor.kind === "dm" ? "private" : "group" } : {}),
    }).chat;
  }

  /** A native thread's speaker, which stands in its parent's chat. */
  private mutateThread(
    descriptor: ChatDescriptor,
    channel: string,
    input: {
      settings: StoredChatSettings | null;
      agentName: string | null | undefined;
    },
  ): void {
    this.db.transaction((tx) => {
      const via = this.accountOn(channel);
      const sourceThreadType = descriptor.kind === "dm" ? "private" : descriptor.kind;
      const parent = descriptor.parent
        ? this.speakerAt(tx, channel, descriptor.parent.chatId)
        : undefined;
      const parentSessionId = parent?.id ?? null;
      const now = new Date();
      tx.insert(romeSessions)
        .values({
          id: channelChatId(channel, descriptor.ref.chatId),
          name: descriptor.displayName,
          personaId: null,
          projectName: DEFAULT_WEBCHAT_PROJECT_NAME,
          projectPath: null,
          largeModelSelection: null,
          agentName: null,
          type: "channel",
          sourceChannel: channel,
          sourceThreadId: descriptor.ref.chatId,
          sourceThreadName: descriptor.displayName,
          sourceThreadType,
          channelSettings: null,
          parentSessionId,
          chatId: parent?.chatId ?? null,
          chatPlatform: parent?.chatPlatform ?? null,
          threadId: descriptor.ref.chatId,
          accountId: via.id,
          createdAt: now,
          activityAt: now,
          lastSeenActivityAt: null,
        })
        .onConflictDoNothing({ target: romeSessions.id })
        .run();

      // As in `mutate`, the session messages through `channel` reach.
      const current = tx
        .select()
        .from(romeSessions)
        .where(eq(romeSessions.id, channelChatId(channel, descriptor.ref.chatId)))
        .get();
      if (!current) {
        throw new Error(`Failed to resolve conversation ${channel}:${descriptor.ref.chatId}`);
      }

      tx.update(romeSessions)
        .set({
          name: descriptor.displayName,
          sourceThreadName: descriptor.displayName,
          sourceThreadType,
          parentSessionId,
          // As in `mutate`, the row is this account's speaker, in its
          // parent's chat when Rome holds that parent.
          ...(parent?.chatId ? { chatId: parent.chatId, chatPlatform: parent.chatPlatform } : {}),
          threadId: descriptor.ref.chatId,
          accountId: via.id,
          channelSettings: input.settings,
          ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        })
        .where(eq(romeSessions.id, current.id))
        .run();
    });
  }
}

interface StoredLookups {
  chats: Map<number, Chat | null>;
  channels: Map<string, string | null>;
  /** Each account's addresses, by chat key. */
  addresses: Map<string, Map<string, string>>;
}

function newLookups(): StoredLookups {
  return { chats: new Map(), channels: new Map(), addresses: new Map() };
}

function isShared(kind: ChatDescriptor["kind"] | null): boolean {
  return kind === "group" || kind === "channel";
}

/**
 * `rule` without its routing marker. A speaker's routing (`overrides.routing`)
 * pins the agent of the one of Rome's accounts the speaker is, as its
 * `agent_name` does, so it is no part of the group's rule.
 */
export function withoutRouting(rule: StoredChatSettings): StoredChatSettings {
  if (rule.overrides.routing === undefined) return rule;
  const { routing: _routing, ...overrides } = rule.overrides;
  return { ...rule, overrides };
}

/** `rule` with the routing marker of `stored`, the settings one speaker
 *  already holds, since that marker is its account's alone. */
export function withRoutingOf(
  stored: StoredChatSettings | null,
  rule: StoredChatSettings | null,
): StoredChatSettings | null {
  const routing = stored?.overrides.routing;
  if (routing === undefined) return rule;
  const base = rule ?? { ...stored!, overrides: {} };
  return { ...base, overrides: { ...base.overrides, routing } };
}

/** Whether a conversation's name only stands in for one the platform has not
 *  given: its address, or the `channel:address` name a session opened with no
 *  name takes, as `backfillChannelConversationName` reads them. */
function isPlaceholderName(channel: string, descriptor: ChatDescriptor): boolean {
  const address = descriptor.ref.chatId;
  return [address, `${channel}:${address}`].includes(descriptor.displayName);
}
