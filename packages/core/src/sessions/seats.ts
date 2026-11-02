// Where each of Rome's agent sessions stands: a seat, one of Rome's accounts
// in a place, and the agent that speaks there. Vocabulary:
// docs/domains/participation.md and docs/domains/chats.md#place.
//
// Agents keeps a seat on its session's row (`rome_sessions`), and the row
// names its chat by Chats' id. Nothing reads through it yet: the Chats
// switch moves seat lookups here.

import type { ChatId } from "@rome-os/app-runtime";
import { eq } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { placeIn, type Place } from "../chats/storage/place.js";
import type { DrizzleDb } from "../db/index.js";
import { romeSessions } from "../db/schema/system.js";

/** A session's seat: the place it stands in, the account of Rome's it speaks
 *  as there, and its agent. */
export interface Seat {
  readonly sessionId: string;
  readonly place: Place;
  readonly accountId: string;
  readonly agent: string;
}

export class Seats {
  private readonly chats: Pick<ChatRepository, "find">;

  constructor(
    private readonly db: DrizzleDb,
    chats?: Pick<ChatRepository, "find">,
  ) {
    this.chats = chats ?? new ChatRepository(db);
  }

  /**
   * Session `sessionId`'s seat, or null when it stands in no chat. A seat
   * that kept no account speaks as the platform's own (the dashboard's), and
   * one that kept no agent is the main agent's.
   */
  seatOf(sessionId: string): Seat | null {
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
}
