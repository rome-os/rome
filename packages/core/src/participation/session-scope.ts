// Which session a turn on a chat's message runs in, by the chat's session
// scope (docs/domains/chats.md#session-scope).

import type { ChatSessionScope } from "@rome-os/app-runtime";

/** A chat on one of Rome's connected accounts: its channel and the
 *  platform's id for it. */
export interface SessionChat {
  channel: string;
  chatId: string;
}

/** The session a chat's turns run in. */
export interface ChatSession {
  /** The key the session opens under. */
  continuityKey: string;
  /** `shared` where the session answers more than one chat, so what a
   *  private chat said never reaches the others as private. Absent, the
   *  chat's own audience holds. */
  audience?: "shared";
}

/**
 * The session `chat` runs in: its own under scope `chat`, the one session of
 * its connected account under scope `account`. No chat id is `*`, so the
 * account's key names no chat's own session.
 */
export function sessionOfChat(chat: SessionChat, scope: ChatSessionScope): ChatSession {
  return scope === "account"
    ? { continuityKey: `${chat.channel}:*`, audience: "shared" }
    : { continuityKey: `${chat.channel}:${chat.chatId}` };
}
