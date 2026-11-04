// Reply rules, kept on each of Rome's speakers. Vocabulary:
// docs/domains/participation.md#speaker and docs/domains/chats.md#chat.

import { and, asc, eq, isNotNull, isNull, like, sql, type SQL } from "drizzle-orm";
import type { Account, ChatDescriptor, ChatId, StoredChatSettings } from "@rome-os/app-runtime";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { chatIdsOn, type ChatRepository } from "../chats/storage/chat-repository.js";
import type { Chat } from "../chats/storage/chat.js";
import { placeIn, type ChatKey, type ChatRef } from "../chats/storage/place.js";
import type { ChatAdapters } from "../connections/chat-adapter.js";
import { chatMessages, romeAgentMessages, romeSessions } from "../db/schema/system.js";
import { channelChatId, isChannelConversation } from "../db/session-kind.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../webchat/constants.js";

type SpeakerRow = typeof romeSessions.$inferSelect;

/** A speaker as chat settings read it: its row, the kind of place it stands
 *  in (a topic when it stands in a thread), the name of that place, and the
 *  platform address its account reaches it at, null when no channel is its
 *  account. */
export type StoredChatRow = SpeakerRow & {
  kind: "dm" | "group" | "topic";
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
  adapters: Pick<ChatAdapters, "chatAt" | "knownAccountOn" | "channelOf" | "addressAt">;
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
        .orderBy(asc(romeSessions.createdAt), asc(romeSessions.id))
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
  channelOf(row: SpeakerRow): string | null {
    if (!row.chatPlatform || !row.accountId) return null;
    return this.deps.adapters.channelOf({ platform: row.chatPlatform, id: row.accountId });
  }

  /** Speaker `row` with the kind and name of the place it stands in, and its
   *  address. */
  private stored(row: SpeakerRow): StoredChatRow {
    const chat: Chat | null = row.chatId ? this.deps.chats.find(row.chatId) : null;
    const kind = row.threadId !== null ? "topic" : chat?.kind === "dm" ? "dm" : "group";
    const channel = this.channelOf(row);
    const address =
      chat && channel
        ? this.deps.adapters.addressAt(
            channel,
            placeIn(chat.ref, row.threadId === null ? undefined : (row.threadId as ChatId)),
          )
        : null;
    const placeName = row.threadId !== null ? row.name : (chat?.name ?? null);
    return { ...row, kind, placeName, address };
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
      predicates.push(like(romeSessions.name, `%${input.query.trim()}%`));
    }
    return this.db
      .select()
      .from(romeSessions)
      .where(and(...predicates))
      .orderBy(asc(romeSessions.accountId), asc(romeSessions.name))
      .all()
      .map((row) => this.stored(row));
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
    if (own?.channelSettings && hasRule(own.channelSettings)) return own.channelSettings;
    if (!isShared(kind) && (own === undefined || this.stored(own).kind !== "group")) {
      return own?.channelSettings ?? null;
    }
    if (!this.deps.adapters.knownAccountOn(channel)) return own?.channelSettings ?? null;
    // Another of Rome's speakers in the group may have set the group's rule.
    const chat = this.chatOf(channel, chatId, "group");
    if (!chat) return own?.channelSettings ?? null;
    const shared = this.db
      .select({ settings: romeSessions.channelSettings })
      .from(romeSessions)
      .where(
        and(
          eq(romeSessions.chatId, chat.id),
          isNull(romeSessions.threadId),
          isNotNull(romeSessions.channelSettings),
        ),
      )
      .orderBy(asc(romeSessions.createdAt), asc(romeSessions.id))
      .all();
    const rule = shared.map((row) => row.settings as StoredChatSettings).find(hasRule) ?? null;
    return withRoutingOf(own?.channelSettings ?? null, rule && withoutRouting(rule));
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
        const existingChat = existing?.chatId ? this.deps.chats.find(existing.chatId) : null;
        const chat =
          existingChat ??
          this.deps.chats.start(
            this.keyOf(channel, descriptor.ref.chatId, descriptor.kind),
            descriptor.kind === "dm" ? "dm" : "group",
            descriptor.displayName,
          );
        this.deps.chats.rename(chat.ref, descriptor.displayName);
        const id = existing?.id ?? channelChatId(channel, descriptor.ref.chatId);
        const now = new Date();
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
            chatId: chat.ref.id,
            chatPlatform: chat.ref.platform,
            accountId: via.id,
            createdAt: now,
            activityAt: now,
            lastSeenActivityAt: null,
          })
          .onConflictDoNothing({ target: romeSessions.id })
          .run();
        tx.update(romeSessions)
          .set({
            name: descriptor.displayName,
            ...(sourceThreadType === null ? {} : { sourceThreadType }),
            // A row stored before it stood in a chat stands in this one now.
            chatId: sql`coalesce(${romeSessions.chatId}, ${chat.ref.id})`,
            chatPlatform: sql`coalesce(${romeSessions.chatPlatform}, ${chat.ref.platform})`,
            accountId: sql`coalesce(${romeSessions.accountId}, ${via.id})`,
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
            .where(and(eq(romeSessions.chatId, chat.ref.id), isNull(romeSessions.threadId)))
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

      const current =
        this.speakerAt(tx, channel, descriptor.ref.chatId) ??
        tx
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
          chatId: sql`coalesce(${romeSessions.chatId}, ${parent?.chatId ?? null})`,
          chatPlatform: sql`coalesce(${romeSessions.chatPlatform}, ${parent?.chatPlatform ?? null})`,
          threadId: sql`coalesce(${romeSessions.threadId}, ${descriptor.ref.chatId})`,
          accountId: sql`coalesce(${romeSessions.accountId}, ${via.id})`,
          channelSettings: input.settings,
          ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        })
        .where(eq(romeSessions.id, current.id))
        .run();
    });
  }
}

function isShared(kind: ChatDescriptor["kind"] | null): boolean {
  return kind === "group" || kind === "channel";
}

/** Whether `settings` holds a rule beyond its routing marker. */
function hasRule(settings: StoredChatSettings): boolean {
  return Object.keys(withoutRouting(settings).overrides).length > 0;
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
