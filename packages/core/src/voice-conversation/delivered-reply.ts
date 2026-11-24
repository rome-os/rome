// A reply as the guardian gets it from an agent whose text is private, such as
// the Concierge. Such an agent answers with the messages its tools add to the
// chat, and its own text, such as a closing "done", is never shown. So the
// conversation reads the messages the turn adds instead of the turn's text:
// each text part is said, and anything else, such as a card, is shown.

import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { ReplyEvent, ReplyTurn } from "./conversation.js";

// How long a reply waits, after its turn ends, for the turn's messages to be stored.
const STORED_WITHIN_MS = 5_000;

/** A message added to a chat, as far as the reply reads it. */
export interface AddedMessage {
  /** The chat it was added to. */
  sessionId: string;
  turnId: string | null;
  role: string;
  /** The stored parts, as JSON. */
  content: string;
}

/** The turn whose delivered messages make the reply. */
interface AnsweringTurn {
  id: string;
  events(): AsyncIterable<StreamAgentEvent>;
}

export interface DeliveredReply {
  /**
   * The reply of `turn`: its messages, and its events that are not its own
   * text. `stored` resolves once the chat has stored every message of the
   * turn, such as a card its stream writes after the turn ends. The reply
   * waits for it up to 5 s.
   */
  of(turn: AnsweringTurn, stored?: () => Promise<unknown>): ReplyTurn;
  /** Stops gathering messages, for a send that started no turn. */
  stop(): void;
}

/**
 * Starts gathering the messages added to chat `chatId` now, before the turn
 * that adds them is known, so none is missed. `subscribe` calls its listener
 * with each message added to any chat and returns the unsubscribe.
 */
export function gatherDelivered(
  chatId: string,
  subscribe: (listener: (message: AddedMessage) => void) => () => void,
): DeliveredReply {
  const early: AddedMessage[] = [];
  let take: ((message: AddedMessage) => void) | null = null;
  const stop = subscribe((message) => (take ? take(message) : early.push(message)));
  return {
    stop,
    of: (turn, stored) => ({
      events: () =>
        readDelivered(chatId, turn, stored, early, stop, (listener) => {
          take = listener;
        }),
    }),
  };
}

async function* readDelivered(
  chatId: string,
  turn: AnsweringTurn,
  stored: (() => Promise<unknown>) | undefined,
  early: AddedMessage[],
  stop: () => void,
  listen: (listener: (message: AddedMessage) => void) => void,
): AsyncGenerator<ReplyEvent> {
  const queue: ReplyEvent[] = [];
  let ended = false;
  let wake = () => {};
  const add = (message: AddedMessage) => {
    // The turn may also send to other chats: only this chat's messages are the reply.
    if (message.sessionId !== chatId || message.turnId !== turn.id) return;
    if (message.role !== "assistant") return;
    queue.push(...partsOf(message.content));
    wake();
  };
  for (const message of early.splice(0)) add(message);
  listen(add);
  // The turn's events run beside the messages. Its own text is private.
  void (async () => {
    try {
      for await (const event of turn.events()) {
        if (event.type === "text" || event.type === "text_delta") continue;
        queue.push(event);
        wake();
      }
      // A message the turn's tools add is stored before the turn ends. A card
      // its stream writes may come after, so the reply waits for the chat.
      if (stored) await storedOrLate(stored);
    } finally {
      ended = true;
      stop();
      wake();
    }
  })();
  try {
    while (true) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    stop();
  }
}

// Resolves once `stored` does, or after STORED_WITHIN_MS, whichever comes first.
async function storedOrLate(stored: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STORED_WITHIN_MS);
  });
  try {
    await Promise.race([stored().catch(() => {}), late]);
  } finally {
    clearTimeout(timer);
  }
}

// What a message says: its text parts. A quote of the message it answers is
// not said, and any other part, such as a card, is shown.
function partsOf(content: string): ReplyEvent[] {
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parts)) return [];
  const events: ReplyEvent[] = [];
  for (const part of parts) {
    const { type, content: text } = (part ?? {}) as { type?: unknown; content?: unknown };
    if (type === "reply_to") continue;
    if (type === "text" && typeof text === "string") events.push({ type: "said", text });
    else events.push({ type: "shown" });
  }
  return events;
}
