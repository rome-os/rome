// The Chat aggregate. Vocabulary: docs/domains/chats.md#chat.

import type { ChatKey } from "./place.js";

/** Whether a chat is a group or a direct message. Something about the chat,
 *  never part of its key. */
export type ChatKind = "dm" | "group";

/**
 * A place Rome's accounts are in, as Chats records it. Who is in it is the
 * platform's to list, and which of Rome's accounts stand in it is their
 * sessions in Agents. `id` is Rome's own id for the chat, which messages and
 * sessions name it by. Its key and kind never change.
 */
export interface Chat {
  readonly id: string;
  readonly key: ChatKey;
  readonly kind: ChatKind;
  /** The platform's name for the chat, or null while it has given none. */
  readonly name: string | null;
  readonly startedAt: Date;
}
