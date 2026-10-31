// The events Chats raises. Vocabulary: docs/domains/chats.md#message.
//
// Each is raised after the write it reports has committed, so a listener that
// reads the record finds what the event says. Connections' bus runs inside
// its transaction instead (connections/events.ts): a listener there writes in
// the same transaction, and a listener here acts on what was written.

import { createLogger } from "../logger.js";
import type { RecordedMessage } from "./message.js";

const log = createLogger("chat-events");

/**
 * How a message reached Rome, over today's storage. `channel` is the channel
 * of the one of Rome's accounts it arrived on, which keys its chat's row.
 */
export interface Via {
  readonly channel: string;
}

/** A message was said in a chat, and is now on record there. A message
 *  recorded again, such as a platform redelivery, raises nothing. */
export interface MessageSaid {
  readonly type: "MessageSaid";
  readonly message: RecordedMessage;
  /** The id of the row the message's chat is over today's storage. */
  readonly chatRecordId: string;
  readonly via: Via;
}

export type ChatEvent = MessageSaid;

export type ChatEventListener = (event: ChatEvent) => void | Promise<void>;

/**
 * Hands each event to every listener, one listener at a time in the order
 * they subscribed. {@link publish} resolves once every listener has finished,
 * so a caller that publishes one chat's events in order has them heard in
 * that order. A listener that throws is logged and the next one still hears
 * the event.
 */
export class ChatEvents {
  private readonly listeners = new Set<ChatEventListener>();

  subscribe(listener: ChatEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async publish(event: ChatEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        await listener(event);
      } catch (error) {
        log.error("chat event listener threw", {
          event: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
