// Where each of Rome's agent sessions stands: a speaker, one of Rome's accounts
// in a place, and the agent that speaks there. Vocabulary:
// docs/domains/participation.md and docs/domains/chats.md#place.
//
// A speaker is read off its session's row (`rome_sessions`), not stored, and the row
// names its chat by Chats' id. Nothing reads through it yet: the Chats
// switch moves speaker lookups here.

import type { ChatId } from "@rome-os/app-runtime";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { placeIn, type Place } from "../chats/storage/place.js";
import type { DrizzleDb } from "../db/index.js";
import { romeSessions } from "../db/schema/system.js";

/** A session's speaker: the place it stands in, the account of Rome's it speaks
 *  as there, and its agent. */
export interface Speaker {
  readonly sessionId: string;
  readonly place: Place;
  readonly accountId: string;
  readonly agent: string;
}

export class Speakers {
  private readonly chats: Pick<ChatRepository, "find">;

  constructor(
    private readonly db: DrizzleDb,
    chats?: Pick<ChatRepository, "find">,
  ) {
    this.chats = chats ?? new ChatRepository(db);
  }

  /**
   * Session `sessionId`'s speaker, or null when it stands in no chat. A speaker
   * that kept no account speaks as the platform's own (the dashboard's), and
   * one that kept no agent is the main agent's.
   */
  speakerOf(sessionId: string): Speaker | null {
    const row = this.db
      .select({
        chatId: romeSessions.chatId,
        threadId: romeSessions.threadId,
        accountId: romeSessions.accountId,
        agentName: romeSessions.agentName,
      })
      .from(romeSessions)
      .where(eq(romeSessions.id, sessionId))
      .get();
    const chat = row?.chatId ? this.chats.find(row.chatId) : null;
    if (!row || !chat) return null;
    return {
      sessionId,
      place: placeIn(chat.ref, row.threadId === null ? undefined : (row.threadId as ChatId)),
      accountId: row.accountId ?? chat.ref.platform,
      agent: row.agentName ?? "main",
    };
  }

  /**
   * The speaker of Rome's account `accountId` in chat `chatId`, in thread
   * `threadId` or the open chat when null, by its session's id, or null when
   * it holds none there.
   */
  speakerIn(chatId: number, threadId: string | null, accountId: string): string | null {
    return this.firstSpeaker(
      and(
        eq(romeSessions.chatId, chatId),
        threadId === null ? isNull(romeSessions.threadId) : eq(romeSessions.threadId, threadId),
        eq(romeSessions.accountId, accountId),
      ),
    );
  }

  /** The speaker of Rome's account `account` in the thread its platform
   *  calls `threadId`, in whichever chat there, or null when it holds none. */
  speakerInThread(threadId: string, account: { platform: string; id: string }): string | null {
    return this.firstSpeaker(
      and(
        eq(romeSessions.threadId, threadId),
        eq(romeSessions.chatPlatform, account.platform),
        eq(romeSessions.accountId, account.id),
      ),
    );
  }

  /** The oldest session `where` names, by id. */
  private firstSpeaker(where: SQL | undefined): string | null {
    return (
      this.db
        .select({ id: romeSessions.id })
        .from(romeSessions)
        .where(where)
        .orderBy(asc(romeSessions.createdAt))
        .limit(1)
        .get()?.id ?? null
    );
  }
}
