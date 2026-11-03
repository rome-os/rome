// An app names a message by the platform's id, as the SDK hands it one. This
// is where such an id becomes the key of the line Rome holds for it where one
// of Rome's speakers stands, and where a line a speaker sent goes back to the
// platform's id for the app. Contract: docs/architecture/channels.md#chat-adapters.
//
// Nothing calls this yet: the Chats switch moves the SDK's message ids onto it.

import type { SaidMessage } from "../chats/storage/message.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import type { Speaker, Speakers } from "../sessions/speakers.js";
import { contextOf, type ContextLine } from "../sessions/turn-links.js";
import { type ChatAdapters, lineAt, platformIdOfLine } from "./chat-adapter.js";

/** Where a speaker stands and the account it speaks as. */
export type SpeakerAt = Pick<Speaker, "place" | "accountId">;

export class SpeakerLines {
  constructor(
    private readonly deps: {
      speakers: Pick<Speakers, "speakerOf">;
      messages: Pick<MessageRepository, "byIds" | "idOf">;
      adapters: Pick<ChatAdapters, "keyOf">;
    },
  ) {}

  /** The key the message the platform calls `platformMessageId` has where
   *  `speaker` stands, as its account heard or sent it. */
  keyIn(speaker: SpeakerAt, platformMessageId: string): string {
    return lineAt(
      this.deps.adapters.keyOf(speaker.place.chat),
      speaker.accountId,
      platformMessageId,
    );
  }

  /** The id of the line Rome holds for the message the platform calls
   *  `platformMessageId` where `speaker` stands, or null when it holds none. */
  idIn(speaker: SpeakerAt, platformMessageId: string): number | null {
    return this.deps.messages.idOf(speaker.place.chat, this.keyIn(speaker, platformMessageId));
  }

  /** The platform's id for the line keyed `lineKey`, which `speaker`'s account
   *  sent or heard, or null for a line the platform gave no id. */
  platformIdIn(speaker: SpeakerAt, lineKey: string): string | null {
    return platformIdOfLine(
      this.deps.adapters.keyOf(speaker.place.chat),
      speaker.accountId,
      lineKey,
    );
  }

  /** The line said in session `sessionId`'s chat, in any of its threads,
   *  whose platform id is `platformMessageId`, or null when Rome holds none
   *  or the session stands in no chat. */
  async recorded(sessionId: string, platformMessageId: string): Promise<SaidMessage | null> {
    const speaker = this.deps.speakers.speakerOf(sessionId);
    if (!speaker) return null;
    const id = this.idIn(speaker, platformMessageId);
    return id === null ? null : (this.deps.messages.byIds([id])[0] ?? null);
  }
}

/**
 * The lines a run an app starts names by the platform's ids, where session
 * `sessionId` stands: the message the turn answers, and the one its reply
 * quotes as the agent reads it. Either is null when Rome holds none.
 */
export async function runLines(
  speakerLines: Pick<SpeakerLines, "recorded"> | undefined,
  sessionId: string,
  run: { readonly platformMessageId?: string; readonly replyTo?: { readonly messageId?: string } },
): Promise<{ prompt: number | null; quoted: ContextLine | null }> {
  const [prompt, quoted] = await Promise.all([
    run.platformMessageId ? speakerLines?.recorded(sessionId, run.platformMessageId) : null,
    run.replyTo?.messageId ? speakerLines?.recorded(sessionId, run.replyTo.messageId) : null,
  ]);
  return { prompt: prompt?.id ?? null, quoted: quoted ? contextOf(quoted) : null };
}
