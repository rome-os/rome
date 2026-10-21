import { and, asc, eq, like } from "drizzle-orm";
import type { ChatDescriptor, ChatId, StoredChatSettings } from "@rome-os/app-runtime";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { channelChatId } from "../db/repositories/webchat.js";
import { romeAgentMessages, romeSessions } from "../db/schema/system.js";
import { isChannelConversation } from "../db/session-kind.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../webchat/constants.js";

export type StoredChatRow = typeof romeSessions.$inferSelect;

function rowByAddress(exec: DrizzleDb | DrizzleTx, service: string, chatId: ChatId) {
  return exec
    .select()
    .from(romeSessions)
    .where(
      and(
        isChannelConversation,
        eq(romeSessions.sourceChannel, service),
        eq(romeSessions.sourceThreadId, chatId),
      ),
    )
    .limit(1)
    .get();
}

export class ChatSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  find(service: string, chatId: ChatId): StoredChatRow | null {
    return rowByAddress(this.db, service, chatId) ?? null;
  }

  listKnown(input: { service?: string; query?: string }): StoredChatRow[] {
    const predicates = [isChannelConversation];
    if (input.service) {
      predicates.push(eq(romeSessions.sourceChannel, input.service));
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

  /** Create if missing, then mutate one aggregate in one SQLite transaction. Callers
   * serialize by address before entering this method. `channel` is the name of
   * the channel the conversation belongs to, which a service's later channels
   * do not share with it. */
  mutate(
    descriptor: ChatDescriptor,
    channel: string,
    input: {
      settings: StoredChatSettings | null;
      agentName: string | null | undefined;
    },
  ): void {
    // A webchat address is a guardian chat, which has no conversation settings.
    if (descriptor.service === "webchat") {
      throw new Error("Webchat chats have no conversation settings");
    }
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
