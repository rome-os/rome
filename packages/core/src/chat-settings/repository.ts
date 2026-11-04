// Reply rules, kept on each of Rome's speakers. Vocabulary:
// docs/domains/participation.md#speaker and docs/domains/chats.md#chat.

import { and, asc, desc, eq, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import type { Account, ChatDescriptor, ChatId, StoredChatSettings } from "@rome-os/app-runtime";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { chatIdsOn, type ChatRepository } from "../chats/storage/chat-repository.js";
import type { Chat } from "../chats/storage/chat.js";
import { placeIn, type ChatKey, type ChatRef } from "../chats/storage/place.js";
import { startChannelChat } from "../connections/channel-chat.js";
import { type ChatAdapters, kindNamedBy } from "../connections/chat-adapter.js";
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
    const first = (...where: SQL[]) =>
      exec
        .select()
        .from(romeSessions)
        .where(and(isChannelConversation, eq(romeSessions.accountId, account.id), ...where))
        // The session messages through `channel` at the address go to, when
        // the account holds more than one there, as after a reconnect.
        .orderBy(
          desc(sql`${romeSessions.id} = ${channelChatId(channel, address)}`),
          asc(romeSessions.createdAt),
          asc(romeSessions.id),
        )
        .limit(1)
        .get();
    for (const kind of ["group", "dm"] as const) {
      const chat = this.chatOf(channel, address, kind);
      const row = chat && first(eq(romeSessions.chatId, chat.id), isNull(romeSessions.threadId));
      if (row) return row;
    }
    return first(
      eq(romeSessions.threadId, address),
      sql`${romeSessions.chatId} in ${chatIdsOn(account.platform)}`,
    );
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
    const address =
      chat && channel
        ? this.deps.adapters.addressAt(
            channel,
            placeIn(chat.ref, row.threadId === null ? undefined : (row.threadId as ChatId)),
          )
        : null;
    const placeName = row.threadId !== null ? row.name : (chat?.name ?? null);
    return { ...row, kind, channel, placeName, address };
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
      return own?.channelSettings ?? null;
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

  /** The kind platform address `chatId` names by itself on `channel`'s
   *  platform ({@link kindNamedBy}), or null where it names none or the
   *  channel knows no account. */
  namedKind(channel: string, chatId: ChatId): "group" | "dm" | null {
    const account = this.deps.adapters.knownAccountOn(channel);
    return account ? kindNamedBy(account.platform, chatId) : null;
  }

  /** "group" when Rome holds a group at address `chatId` on `channel`'s
   *  platform, through any of its accounts, whose kind is then fixed; else
   *  null. */
  heldKind(channel: string, chatId: ChatId): "group" | null {
    if (!this.deps.adapters.knownAccountOn(channel)) return null;
    return this.chatOf(channel, chatId, "group") ? "group" : null;
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
        const named = descriptor.displayName !== descriptor.ref.chatId;
        if (named) this.deps.chats.rename(chat, descriptor.displayName);
        // The session messages through `channel` at the address reach, which
        // a retired one left by a reconnect is not.
        const id = channelChatId(channel, descriptor.ref.chatId);
        const now = new Date();
        // Placed before anything was said, it starts a second early, so the
        // first message, heard within the second, is one it has not seen.
        const placedAt = new Date(Math.floor(now.getTime() / 1000) * 1000 - 1000);
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
            name: descriptor.displayName,
            ...(sourceThreadType === null ? {} : { sourceThreadType }),
            // The row is this account's speaker in this chat. One stored
            // before it stood in a chat stands here now, and one left by the
            // account the channel was paired as before moves here, as the
            // first message after a re-pairing moves it.
            chatId: chat.id,
            chatPlatform: chat.platform,
            accountId: via.id,
            // The routing marker is this account's alone, so only its row holds it.
            channelSettings: input.settings,
            ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
          })
          .where(eq(romeSessions.id, id))
          .run();
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
      ...(descriptor.displayName !== address ? { threadName: descriptor.displayName } : {}),
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
}

function newLookups(): StoredLookups {
  return { chats: new Map(), channels: new Map() };
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
