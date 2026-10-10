import { randomUUID } from "node:crypto";

/** Prefix of the unique key a chat routine card's routine is created with. The
 * card finds its routine by this key after a reload; `POST /api/routines`
 * accepts only keys with this prefix. */
export const CHAT_ROUTINE_KEY_PREFIX = "chat-routine:";

/** A fresh key for a draft card, minted by the webchat drain. */
export function mintChatRoutineKey(): string {
  return `${CHAT_ROUTINE_KEY_PREFIX}${randomUUID()}`;
}

/** The key of a routine `propose_routine` auto-enables, derived from the tool
 * call so the drain can compute the card's key itself. */
export function chatRoutineKeyForToolUse(toolUseId: string): string {
  return `${CHAT_ROUTINE_KEY_PREFIX}${toolUseId}`;
}
