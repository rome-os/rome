// An app names a message by the platform's id, as the SDK hands it one. This
// is where such an id becomes the key of the line Rome holds for it where one
// of Rome's seats stands, and where a line a seat sent goes back to the
// platform's id for the app. Contract: docs/architecture/channels.md#chat-adapters.

import { lineAt, platformIdOfLine } from "../chats/adapter.js";
import type { SaidMessage } from "../chats/message.js";
import type { ChatAdapters } from "../chats/adapter.js";
import type { MessageRepository } from "../chats/message-repository.js";
import type { Seat, WebChatRepository } from "../db/repositories/webchat.js";
import { contextOf, type ContextLine } from "../sessions/turn-links.js";

/** Where a seat stands and the account it speaks as. */
export type SeatAt = Pick<Seat, "place" | "accountId">;

export class SeatLines {
  constructor(
    private readonly deps: {
      seats: Pick<WebChatRepository, "seatOf">;
      messages: Pick<MessageRepository, "byIds" | "idOf">;
      adapters: Pick<ChatAdapters, "keyOf">;
    },
  ) {}

  /** The key the message the platform calls `platformMessageId` has where
   *  `seat` stands, as its account heard or sent it. */
  keyIn(seat: SeatAt, platformMessageId: string): string {
    return lineAt(this.deps.adapters.keyOf(seat.place.chat), seat.accountId, platformMessageId);
  }

  /** The id of the line Rome holds for the message the platform calls
   *  `platformMessageId` where `seat` stands, or null when it holds none. */
  idIn(seat: SeatAt, platformMessageId: string): number | null {
    return this.deps.messages.idOf(seat.place.chat, this.keyIn(seat, platformMessageId));
  }

  /** The platform's id for the line keyed `lineKey`, which `seat`'s account
   *  sent or heard, or null for a line the platform gave no id. */
  platformIdIn(seat: SeatAt, lineKey: string): string | null {
    return platformIdOfLine(this.deps.adapters.keyOf(seat.place.chat), seat.accountId, lineKey);
  }

  /** The line said in session `sessionId`'s chat, in any of its threads,
   *  whose platform id is `platformMessageId`, or null when Rome holds none
   *  or the session stands in no chat. */
  async recorded(sessionId: string, platformMessageId: string): Promise<SaidMessage | null> {
    const seat = await this.deps.seats.seatOf(sessionId);
    if (!seat) return null;
    const id = this.idIn(seat, platformMessageId);
    return id === null ? null : (this.deps.messages.byIds([id])[0] ?? null);
  }
}

/**
 * The lines a run an app starts names by the platform's ids, where session
 * `sessionId` stands: the message the turn answers, and the one its reply
 * quotes as the agent reads it. Either is null when Rome holds none.
 */
export async function runLines(
  seatLines: Pick<SeatLines, "recorded"> | undefined,
  sessionId: string,
  run: { readonly platformMessageId?: string; readonly replyTo?: { readonly messageId?: string } },
): Promise<{ prompt: number | null; quoted: ContextLine | null }> {
  const [prompt, quoted] = await Promise.all([
    run.platformMessageId ? seatLines?.recorded(sessionId, run.platformMessageId) : null,
    run.replyTo?.messageId ? seatLines?.recorded(sessionId, run.replyTo.messageId) : null,
  ]);
  return { prompt: prompt?.id ?? null, quoted: quoted ? contextOf(quoted) : null };
}
