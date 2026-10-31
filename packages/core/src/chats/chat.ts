// The Chat aggregate. Vocabulary: docs/domains/chats.md#chat.

import type { ChatRef } from "./place.js";

/** Whether a chat is a group or a direct message. Something about the chat,
 *  never part of its key. */
export type ChatKind = "dm" | "group";

/**
 * A place Rome's accounts are in, as Chats records it. Who is in it is the
 * platform's to list, and which of Rome's accounts stand in it is their
 * sessions in Agents. `ref` names it: its platform and its adapter's id for
 * it, which messages and sessions name it by. Its ref and kind never change.
 */
export interface Chat {
  readonly ref: ChatRef;
  readonly kind: ChatKind;
  /** The platform's name for the chat, or null while it has given none. */
  readonly name: string | null;
  readonly startedAt: Date;
}
