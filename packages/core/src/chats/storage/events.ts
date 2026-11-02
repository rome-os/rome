// The events Chats raises over its own tables. Vocabulary:
// docs/domains/chats.md#message.
//
// Each is raised after the write it reports has committed, so a listener that
// reads the record finds what the event says. Nothing raises them until the
// Chats switch; `chats/events.ts` is the legacy rows' bus.

import type { Account } from "@rome-os/app-runtime";
import { createLogger } from "../../logger.js";
import type { RecordedMessage } from "./message.js";

const log = createLogger("chat-events");

/** Which of Rome's accounts heard a message, and the channel it is reached
 *  on. */
export interface Via {
  readonly channel: string;
  readonly account: Account;
}

/** A message was said in a chat, and is now on record there. A message
 *  recorded again, such as a platform redelivery, raises nothing. */
export interface MessageSaid {
  readonly type: "MessageSaid";
  readonly message: RecordedMessage;
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
