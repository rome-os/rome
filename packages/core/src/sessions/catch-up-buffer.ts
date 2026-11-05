// What a session has not seen on a platform Chats keeps no copy of.
// Vocabulary: docs/domains/participation.md#wake.
//
// Prototype. Where Chats records a platform's messages, a woken agent catches
// up on the record (`TurnLinks.unseen`). Where it does not, each message one
// of Rome's accounts heard waits here, in memory, by the session of the
// account's speaker in its place, until a turn of that session catches up on
// it or takes it as its prompt. A restart forgets it: the agent reads the
// platform's history with its tools instead.

import type { UnseenLine } from "./turn-links.js";

/** A message heard and not recorded, as a session reads it. */
export interface HeardMessage {
  /** Negative, so it never names a message on record. */
  readonly id: number;
  /** The platform's id for it, as an app names it. */
  readonly platformMessageId: string;
  readonly senderName: string | null;
  readonly text: string;
  readonly at: Date;
}

interface Waiting {
  readonly message: HeardMessage;
  /** Whether its wake is still being decided: it may yet be a prompt. */
  undecided: boolean;
}

/** How many messages wait for one session. Past it the oldest is dropped. */
const KEPT_PER_SESSION = 200;

export class CatchUpBuffer {
  private readonly waiting = new Map<string, Waiting[]>();
  /** The session each waiting message waits for, by id. */
  private readonly sessionOf = new Map<number, string>();

  /** Message `message` was heard where session `sessionId` stands. Its wake
   *  is undecided until {@link decided}. Safe to call again. */
  heard(sessionId: string, message: HeardMessage): void {
    if (this.sessionOf.has(message.id)) return;
    const list = this.waiting.get(sessionId) ?? [];
    list.push({ message, undecided: true });
    this.sessionOf.set(message.id, sessionId);
    while (list.length > KEPT_PER_SESSION) {
      const dropped = list.shift();
      if (dropped) this.sessionOf.delete(dropped.message.id);
    }
    this.waiting.set(sessionId, list);
  }

  /** Message `id`'s wake is decided. */
  decided(id: number): void {
    const sessionId = this.sessionOf.get(id);
    const entry = sessionId && this.waiting.get(sessionId)?.find((each) => each.message.id === id);
    if (entry) entry.undecided = false;
  }

  /** Session `sessionId` takes the message the platform calls
   *  `platformMessageId` as a turn's prompt, so it is no longer unseen. */
  prompted(sessionId: string, platformMessageId: string): void {
    const list = this.waiting.get(sessionId);
    const entry = list?.find((each) => each.message.platformMessageId === platformMessageId);
    if (entry) this.drop(sessionId, [entry.message.id]);
  }

  /** What session `sessionId` has not seen, oldest first: every message
   *  waiting for it whose wake is decided. */
  unseen(sessionId: string): UnseenLine[] {
    return (this.waiting.get(sessionId) ?? [])
      .filter((each) => !each.undecided)
      .map(({ message }) => ({
        id: message.id,
        senderName: message.senderName,
        text: message.text,
        at: message.at,
        fromRome: false,
        quoted: null,
        quotesOutside: false,
      }));
  }

  /** Session `sessionId` caught up on `ids`. */
  seen(ids: readonly number[], sessionId: string): void {
    this.drop(sessionId, ids);
  }

  private drop(sessionId: string, ids: readonly number[]): void {
    const gone = new Set(ids);
    const list = this.waiting.get(sessionId);
    if (!list) return;
    const kept = list.filter((each) => !gone.has(each.message.id));
    for (const id of gone) if (this.sessionOf.get(id) === sessionId) this.sessionOf.delete(id);
    if (kept.length > 0) this.waiting.set(sessionId, kept);
    else this.waiting.delete(sessionId);
  }
}
