// A reply as the guardian gets it from an agent whose text is private, such as
// the Concierge. Such an agent answers with the messages its tools add to the
// chat, and its own text, such as a closing "done", is never shown. So the
// conversation reads the messages the turn adds instead of the turn's text:
// each text part is said, and anything else, such as a card, is shown.

import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { ReplyEvent, ReplyTurn } from "./conversation.js";

/** A message added to the chat, as far as the reply reads it. */
export interface AddedMessage {
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
  /** The reply of `turn`: its messages, and its events that are not its own text. */
  of(turn: AnsweringTurn): ReplyTurn;
  /** Stops gathering messages, for a send that started no turn. */
  stop(): void;
}

/**
 * Starts gathering the messages added to the chat now, before the turn that
 * adds them is known, so none is missed. `subscribe` calls its listener with
 * each message added and returns the unsubscribe.
 */
export function gatherDelivered(
  subscribe: (listener: (message: AddedMessage) => void) => () => void,
): DeliveredReply {
  const early: AddedMessage[] = [];
  let take: ((message: AddedMessage) => void) | null = null;
  const stop = subscribe((message) => (take ? take(message) : early.push(message)));
  return {
    stop,
    of: (turn) => ({
      events: () =>
        readDelivered(turn, early, stop, (listener) => {
          take = listener;
        }),
    }),
  };
}

async function* readDelivered(
  turn: AnsweringTurn,
  early: AddedMessage[],
  stop: () => void,
  listen: (listener: (message: AddedMessage) => void) => void,
): AsyncGenerator<ReplyEvent> {
  const queue: ReplyEvent[] = [];
  let ended = false;
  let wake = () => {};
  const add = (message: AddedMessage) => {
    if (message.turnId !== turn.id || message.role !== "assistant") return;
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
    } finally {
      // Every message of the turn is added before it ends.
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
