import { and, asc, eq, like } from "drizzle-orm";
import type { ChatDescriptor, ChatId, StoredChatSettings } from "@rome-os/app-runtime";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import type { ChatRepository } from "../chats/chat-repository.js";
import { chatKey } from "../chats/place.js";
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

export class ChatSettingsRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly chats: ChatRepository,
  ) {}

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

  hasMessageHistory(sessionId: string): boolean {
    return (
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
    this.db.transaction((tx) => {
      const via = this.chats.accountOn(channel);
      const key = chatKey(via.platform, descriptor.ref.chatId);
      const sourceThreadType = descriptor.kind === "dm" ? "private" : descriptor.kind;
      this.chats.startIfMissing(
        key,
        descriptor.kind === "dm" ? "dm" : "group",
        via,
        descriptor.displayName,
        { threadType: sourceThreadType },
      );
      this.chats.update(key, (chat) => {
        chat.rename(descriptor.displayName);
        chat.setReplyRule(via, input.settings);
      });
      tx.update(romeSessions)
        .set({
          sourceThreadType,
          ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        })
        .where(eq(romeSessions.id, channelChatId(channel, descriptor.ref.chatId)))
        .run();
    });
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
