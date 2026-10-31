import { and, asc, eq, isNotNull, isNull, like, sql } from "drizzle-orm";
import type { Account, ChatDescriptor, ChatId, StoredChatSettings } from "@rome-os/app-runtime";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { ChatRepository } from "../chats/chat-repository.js";
import { chatAt } from "../chats/adapter.js";
import { MessageRepository } from "../chats/message-repository.js";
import { placeIn, type ChatRef } from "../chats/place.js";
import { romeAgentMessages, romeSessions } from "../db/schema/system.js";
import { channelChatId, isChannelConversation } from "../db/session-kind.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../webchat/constants.js";

export type StoredChatRow = typeof romeSessions.$inferSelect;

function rowByAddress(exec: DrizzleDb | DrizzleTx, channel: string, chatId: ChatId) {
  return exec
    .select()
    .from(romeSessions)
    .where(
      and(
        isChannelConversation,
        eq(romeSessions.sourceChannel, channel),
        eq(romeSessions.sourceThreadId, chatId),
      ),
    )
    .limit(1)
    .get();
}

export interface ChatSettingsRepositoryDeps {
  /** Where a chat is started when a rule is set before anything was said. */
  chats: Pick<ChatRepository, "start" | "rename">;
  /** Rome's own account on a channel, or null while its record knows none. */
  accountOf(channel: string): Account | null;
  platformOfChannel(channel: string): string;
}

/**
 * Reply rules, kept on each of Rome's seats (`rome_sessions.channel_settings`).
 * A group's rule is the group's whichever of Rome's accounts set it, so it is
 * written to every seat in the chat; each seat keeps its own routing marker.
 */
export class ChatSettingsRepository {
  /** Chats, read to tell whether anything was said where a seat stands. */
  private readonly messages: {
    chats: Pick<ChatRepository, "find">;
    lines: Pick<MessageRepository, "read">;
  };

  constructor(
    private readonly db: DrizzleDb,
    private readonly deps: ChatSettingsRepositoryDeps,
  ) {
    this.messages = { chats: new ChatRepository(db), lines: new MessageRepository(db) };
  }

  /** The account `channel` speaks as. */
  private accountOn(channel: string): Account {
    return (
      this.deps.accountOf(channel) ?? {
        platform: this.deps.platformOfChannel(channel),
        id: channel,
      }
    );
  }

  /** The chat at address `chatId` as `channel`'s account sees it. */
  private chatOf(channel: string, chatId: ChatId, kind: ChatDescriptor["kind"]): ChatRef {
    const via = this.accountOn(channel);
    return kind === "dm"
      ? chatAt(via.platform, chatId, { romeEnd: via.id })
      : chatAt(via.platform, chatId);
  }

  find(channel: string, chatId: ChatId): StoredChatRow | null {
    return rowByAddress(this.db, channel, chatId) ?? null;
  }

  listKnown(input: { channel?: string; query?: string }): StoredChatRow[] {
    const predicates = [isChannelConversation];
    if (input.channel) {
      predicates.push(eq(romeSessions.sourceChannel, input.channel));
    }
    if (input.query?.trim()) {
      predicates.push(like(romeSessions.sourceThreadName, `%${input.query.trim()}%`));
    }
    return this.db
      .select()
      .from(romeSessions)
      .where(and(...predicates))
      .orderBy(asc(romeSessions.sourceChannel), asc(romeSessions.sourceThreadName))
      .all();
  }

  /** The reply rule of the chat at `chatId` as the account `channel` speaks
   *  as sees it: the group's, whichever of Rome's accounts set it, or the
   *  account's own direct message's. A row stored with no type reads as the
   *  `kind` its platform described, as `mutate` will store it, and alone when
   *  `kind` is null. An address the account has no row at reads a group's
   *  rule only when `kind` names a group or channel. The routing marker is
   *  the account's own row's. Null when none is set. */
  ruleOf(
    channel: string,
    chatId: ChatId,
    kind: ChatDescriptor["kind"] | null,
  ): StoredChatSettings | null {
    const own = rowByAddress(this.db, channel, chatId);
    if (own === undefined && !isShared(kind)) return null;
    if (own?.channelSettings && hasRule(own.channelSettings)) return own.channelSettings;
    if (
      !isShared(kind) &&
      own?.sourceThreadType !== "group" &&
      own?.sourceThreadType !== "channel"
    ) {
      return own?.channelSettings ?? null;
    }
    // Another of Rome's seats in the group may have set the group's rule.
    const chat = this.chatOf(channel, chatId, "group");
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

  /**
   * Mark the row of the group or channel `descriptor` names on `channel` with
   * that kind when its row was stored with none, so it reads as one chat with
   * the rows of Rome's other accounts in it. Changes no other row.
   */
  private classify(exec: DrizzleTx, descriptor: ChatDescriptor, channel: string): void {
    if (!isShared(descriptor.kind)) return;
    exec
      .update(romeSessions)
      .set({ sourceThreadType: descriptor.kind })
      .where(
        and(
          eq(romeSessions.id, channelChatId(channel, descriptor.ref.chatId)),
          isNull(romeSessions.parentSessionId),
          isNull(romeSessions.sourceThreadType),
        ),
      )
      .run();
  }

  /** The platform channel `channel`'s accounts live on. */
  platformOf(channel: string): string {
    return this.accountOn(channel).platform;
  }

  /** Whether anything was said where session `sessionId` stands, or it ran
   *  a turn. */
  hasMessageHistory(sessionId: string): boolean {
    const seat = this.db
      .select({ chatId: romeSessions.chatId, threadId: romeSessions.threadId })
      .from(romeSessions)
      .where(eq(romeSessions.id, sessionId))
      .get();
    const chat = seat?.chatId ? this.messages.chats.find(seat.chatId) : null;
    const said =
      chat !== null &&
      seat !== undefined &&
      this.messages.lines.read(
        placeIn(chat.ref, seat.threadId === null ? undefined : (seat.threadId as ChatId)),
        { limit: 1 },
      ).messages.length > 0;
    return (
      said ||
      this.db
        .select({ id: romeAgentMessages.id })
        .from(romeAgentMessages)
        .where(eq(romeAgentMessages.sessionId, sessionId))
        .limit(1)
        .get() !== undefined
    );
  }

  /**
   * Set the reply rule of the conversation `descriptor` names, through the
   * account `channel` speaks as, starting the chat when Rome holds none there
   * yet, and bind its row to `agentName` unless that is undefined. One SQLite
   * transaction. Callers serialize by address before entering this method.
   * `channel` is the name of the channel the conversation belongs to, which a
   * connection kind's later channels do not share with it.
   */
  mutate(
    descriptor: ChatDescriptor,
    channel: string,
    input: {
      settings: StoredChatSettings | null;
      agentName: string | null | undefined;
      /** False when `descriptor.kind` is only a guess, made for a row stored
       *  with no type that its platform has never described. The row then
       *  keeps no type, and joins no group. */
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
    // Immediate, as the chat repository's writes are: it reads before it
    // writes, and another connection may commit in between.
    this.db.transaction(
      (tx) => {
        // A row stored before its type was known joins its group's other rows
        // first, so the rule below is written to the whole group.
        const kindKnown = input.kindKnown ?? true;
        if (kindKnown) this.classify(tx, descriptor, channel);
        const via = this.accountOn(channel);
        const place = this.chatOf(channel, descriptor.ref.chatId, descriptor.kind);
        const sourceThreadType = !kindKnown
          ? null
          : descriptor.kind === "dm"
            ? "private"
            : descriptor.kind;
        const chat = this.deps.chats.start(
          place,
          descriptor.kind === "dm" ? "dm" : "group",
          descriptor.displayName,
        );
        this.deps.chats.rename(chat.ref, descriptor.displayName);
        const id = channelChatId(channel, descriptor.ref.chatId);
        const now = new Date();
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
            accountId: via.id,
            createdAt: now,
            activityAt: now,
            lastSeenActivityAt: null,
          })
          .onConflictDoNothing({ target: romeSessions.id })
          .run();
        tx.update(romeSessions)
          .set({
            ...(sourceThreadType === null ? {} : { sourceThreadType }),
            name: descriptor.displayName,
            sourceThreadName: descriptor.displayName,
            // The routing marker is this account's alone, so only its row holds it.
            channelSettings: input.settings,
            ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
          })
          .where(eq(romeSessions.id, id))
          .run();
        // A group's rule is the group's: every other seat there takes it,
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

  /** A native thread's row. A thread is no chat of its own, so its row is
   *  written as it stands until threads have a home in the chat. */
  private mutateThread(
    descriptor: ChatDescriptor,
    channel: string,
    input: {
      settings: StoredChatSettings | null;
      agentName: string | null | undefined;
    },
  ): void {
    this.db.transaction((tx) => {
      const sourceThreadType = descriptor.kind === "dm" ? "private" : descriptor.kind;
      const parentSessionId = descriptor.parent
        ? (rowByAddress(tx, channel, descriptor.parent.chatId)?.id ?? null)
        : null;
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
          createdAt: now,
          activityAt: now,
          lastSeenActivityAt: null,
        })
        .onConflictDoNothing({ target: romeSessions.id })
        .run();

      const current = rowByAddress(tx, channel, descriptor.ref.chatId);
      if (!current) {
        throw new Error(`Failed to resolve conversation ${channel}:${descriptor.ref.chatId}`);
      }

      tx.update(romeSessions)
        .set({
          name: descriptor.displayName,
          sourceChannel: channel,
          sourceThreadName: descriptor.displayName,
          sourceThreadType,
          parentSessionId,
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
 * `rule` without its routing marker. A row's routing (`overrides.routing`)
 * pins the agent of the one of Rome's accounts the row is stored under, as the
 * row's `agent_name` does, so it is no part of the group's rule.
 */
export function withoutRouting(rule: StoredChatSettings): StoredChatSettings {
  if (rule.overrides.routing === undefined) return rule;
  const { routing: _routing, ...overrides } = rule.overrides;
  return { ...rule, overrides };
}

/** `rule` with the routing marker of `stored`, the settings one row already
 *  holds, since that marker is its account's alone. */
export function withRoutingOf(
  stored: StoredChatSettings | null,
  rule: StoredChatSettings | null,
): StoredChatSettings | null {
  const routing = stored?.overrides.routing;
  if (routing === undefined) return rule;
  const base = rule ?? { ...stored!, overrides: {} };
  return { ...base, overrides: { ...base.overrides, routing } };
}
