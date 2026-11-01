import { and, asc, eq, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import type { Account, ChatDescriptor, ChatId, StoredChatSettings } from "@rome-os/app-runtime";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { ChatRepository, chatIdsOn } from "../chats/chat-repository.js";
import type { ChatAdapters } from "../chats/adapter.js";
import { MessageRepository } from "../chats/message-repository.js";
import { placeIn, type ChatRef } from "../chats/place.js";
import { romeAgentMessages, romeSessions } from "../db/schema/system.js";
import { channelChatId, isChannelConversation } from "../db/session-kind.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../webchat/constants.js";

/** A seat as chat settings read it: its row, the kind of place it stands in
 *  (a topic when it stands in a thread), and the platform address its
 *  account reaches it at, null when no channel is its account. */
export type StoredChatRow = typeof romeSessions.$inferSelect & {
  kind: "dm" | "group" | "topic";
  address: ChatId | null;
};

type SeatRow = typeof romeSessions.$inferSelect;

export interface ChatSettingsRepositoryDeps {
  /** Where a chat is started when a rule is set before anything was said. */
  chats: Pick<ChatRepository, "start" | "rename">;
  /** The chat adapters, which name the chat at an address and the channel
   *  that is one of Rome's accounts. */
  adapters: Pick<ChatAdapters, "chatAt" | "accountOn" | "channelOf" | "addressAt">;
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
    return this.deps.adapters.accountOn(channel);
  }

  /** The chat at address `chatId` as `channel`'s account sees it. */
  private chatOf(channel: string, chatId: ChatId, kind: ChatDescriptor["kind"]): ChatRef {
    return this.deps.adapters.chatAt(channel, chatId, kind === "dm" ? "dm" : "group");
  }

  /**
   * The seat `channel`'s account holds at address `address`: in the group
   * there, else the direct message there, else the thread the address names.
   * Found by the chat and the account, never by the channel.
   */
  private seatAt(
    exec: DrizzleDb | DrizzleTx,
    channel: string,
    address: ChatId,
  ): SeatRow | undefined {
    const account = this.accountOn(channel).id;
    const first = (...where: SQL[]) =>
      exec
        .select()
        .from(romeSessions)
        .where(and(isChannelConversation, eq(romeSessions.accountId, account), ...where))
        .orderBy(asc(romeSessions.createdAt))
        .limit(1)
        .get();
    for (const kind of ["group", "dm"] as const) {
      const chat = this.deps.adapters.chatAt(channel, address, kind);
      const row = first(eq(romeSessions.chatId, chat.id), isNull(romeSessions.threadId));
      if (row) return row;
    }
    return first(eq(romeSessions.threadId, address));
  }

  /** The channel the seat `row` speaks through: the one that is its account
   *  on its chat's platform, or null when none is. */
  channelOf(row: SeatRow): string | null {
    const chat = row.chatId ? this.messages.chats.find(row.chatId) : null;
    if (!chat || !row.accountId) return null;
    return this.deps.adapters.channelOf({ platform: chat.ref.platform, id: row.accountId });
  }

  /** Seat `row` with the kind of place it stands in and its address. */
  private stored(row: SeatRow): StoredChatRow {
    const chat = row.chatId ? this.messages.chats.find(row.chatId) : null;
    const kind = row.threadId !== null ? "topic" : chat?.kind === "dm" ? "dm" : "group";
    const channel = this.channelOf(row);
    const address =
      chat && channel
        ? this.deps.adapters.addressAt(
            channel,
            placeIn(chat.ref, row.threadId === null ? undefined : (row.threadId as ChatId)),
          )
        : null;
    return { ...row, kind, address };
  }

  find(channel: string, chatId: ChatId): StoredChatRow | null {
    const row = this.seatAt(this.db, channel, chatId);
    return row ? this.stored(row) : null;
  }

  listKnown(input: { channel?: string; query?: string }): StoredChatRow[] {
    const predicates = [isChannelConversation];
    if (input.channel) {
      // The channel's seats: its account's, in chats on its platform.
      const account = this.accountOn(input.channel);
      predicates.push(
        eq(romeSessions.accountId, account.id),
        sql`${romeSessions.chatId} in ${chatIdsOn(account.platform)}`,
      );
    }
    if (input.query?.trim()) {
      const pattern = `%${input.query.trim()}%`;
      predicates.push(
        or(like(romeSessions.name, pattern), like(romeSessions.threadName, pattern))!,
      );
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
    const own = this.seatAt(this.db, channel, chatId);
    if (own === undefined && !isShared(kind)) return null;
    if (own?.channelSettings && hasRule(own.channelSettings)) return own.channelSettings;
    if (!isShared(kind) && (own === undefined || this.stored(own).kind !== "group")) {
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
        const kindKnown = input.kindKnown ?? true;
        const via = this.accountOn(channel);
        const place = this.chatOf(channel, descriptor.ref.chatId, descriptor.kind);
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
      const parent = descriptor.parent
        ? this.seatAt(tx, channel, descriptor.parent.chatId)
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
          threadName: descriptor.displayName,
          channelSettings: null,
          parentSessionId,
          // A thread's seat stands in its parent's chat, as the account.
          chatId: parent?.chatId ?? null,
          chatPlatform: parent?.chatPlatform ?? null,
          threadId: descriptor.ref.chatId,
          accountId: this.accountOn(channel).id,
          createdAt: now,
          activityAt: now,
          lastSeenActivityAt: null,
        })
        .onConflictDoNothing({ target: romeSessions.id })
        .run();

      const current = this.seatAt(tx, channel, descriptor.ref.chatId);
      if (!current) {
        throw new Error(`Failed to resolve conversation ${channel}:${descriptor.ref.chatId}`);
      }

      tx.update(romeSessions)
        .set({
          name: descriptor.displayName,
          threadName: descriptor.displayName,
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
