// An app names a message by the platform's id, as the SDK hands it one. This
// is where such an id becomes the key of the message Rome holds for it where one
// of Rome's speakers stands, and where a message a speaker sent goes back to the
// platform's id for the app. Contract: docs/architecture/channels.md#chat-adapters.
//
// Nothing calls this yet: the Chats switch moves the SDK's message ids onto it.

import type { SaidMessage } from "../chats/storage/message.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import type { SpeakerReplies } from "../sessions/speaker-replies.js";
import type { Speaker, Speakers } from "../sessions/speakers.js";
import type { MessageAsRead, SenderLabels } from "../chats/sender-labels.js";
import { contextOf, type TurnLinks } from "../sessions/turn-links.js";
import { type ChatAdapters, messageKeyAt, platformIdOfMessage } from "./chat-adapter.js";

/** Where a speaker stands and the account it speaks as. */
export type SpeakerAt = Pick<Speaker, "place" | "accountId">;

export class SpeakerMessages {
  constructor(
    private readonly deps: {
      speakers: Pick<Speakers, "speakerOf">;
      messages: Pick<MessageRepository, "byIds" | "idOf">;
      adapters: Pick<ChatAdapters, "keyOf">;
    },
  ) {}

  /** Whether session `sessionId` stands in a chat, where what its account
   *  sends goes on record as it is sent. */
  stands(sessionId: string): boolean {
    return this.deps.speakers.speakerOf(sessionId) !== null;
  }

  /** The key the message the platform calls `platformMessageId` has where
   *  `speaker` stands, as its account heard or sent it. */
  keyIn(speaker: SpeakerAt, platformMessageId: string): string {
    return messageKeyAt(
      this.deps.adapters.keyOf(speaker.place.chat),
      speaker.accountId,
      platformMessageId,
    );
  }

  /** The id of the message Rome holds for the message the platform calls
   *  `platformMessageId` where `speaker` stands, or null when it holds none. */
  idIn(speaker: SpeakerAt, platformMessageId: string): number | null {
    return this.deps.messages.idOf(speaker.place.chat, this.keyIn(speaker, platformMessageId));
  }

  /** The platform's id for the message keyed `messageKey`, which `speaker`'s account
   *  sent or heard, or null for a message the platform gave no id. */
  platformIdIn(speaker: SpeakerAt, messageKey: string): string | null {
    return platformIdOfMessage(
      this.deps.adapters.keyOf(speaker.place.chat),
      speaker.accountId,
      messageKey,
    );
  }

  /** The message said in session `sessionId`'s chat, in any of its threads,
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
 * The messages a run an app starts names by the platform's ids, where session
 * `sessionId` stands: the message the turn answers, as its id and as the agent
 * reads it, and the one its reply quotes as the agent reads it. Each is null
 * when Rome holds none.
 */
export async function runLines(
  speakerMessages: Pick<SpeakerMessages, "recorded"> | undefined,
  labels: Pick<SenderLabels, "read">,
  sessionId: string,
  run: { readonly platformMessageId?: string; readonly replyTo?: { readonly messageId?: string } },
): Promise<{ prompt: number | null; current: MessageAsRead | null; quoted: MessageAsRead | null }> {
  const said = await Promise.all([
    run.platformMessageId ? speakerMessages?.recorded(sessionId, run.platformMessageId) : null,
    run.replyTo?.messageId ? speakerMessages?.recorded(sessionId, run.replyTo.messageId) : null,
  ]);
  const held = said.flatMap((message) => (message ? [message] : []));
  const read = new Map((await labels.read(held.map(contextOf))).map((m) => [m.id, m]));
  const [prompt, quoted] = said;
  return {
    prompt: prompt?.id ?? null,
    current: (prompt && read.get(prompt.id)) || null,
    quoted: (quoted && read.get(quoted.id)) || null,
  };
}

/** What a run reads its messages through: the messages it names by the platform's
 *  ids, who said them, and the turn links its prompt becomes its turn's through. */
export interface RunLineDeps {
  lines: Pick<SpeakerMessages, "recorded" | "stands">;
  labels: Pick<SenderLabels, "read">;
  links: Pick<TurnLinks, "prompt">;
  /** Told the agent each turn runs, so its replies are said by it. */
  replies?: Pick<SpeakerReplies, "runs">;
}
