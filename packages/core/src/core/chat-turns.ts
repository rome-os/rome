import type { ChatRef } from "@rome-os/app-runtime";

/** The turn running in a chat, and the platform user whose message started it. */
export interface ChatTurn {
  turnId: string;
  initiatorId?: string;
}

/**
 * Which turn runs in each connected account's chat, and who started it. The
 * web chat side holds it for Participation until Participation has a home of
 * its own. The newest turn started in a chat is its turn; ending an older one
 * leaves it in place.
 */
export interface ChatTurns {
  /** Records `turn` as the one running in `chat`. The returned call ends it. */
  start(chat: ChatRef, turn: ChatTurn): () => void;
  /** The turn running in `chat`, if any. */
  runningIn(chat: ChatRef): ChatTurn | undefined;
}

function chatKey(ref: ChatRef): string {
  return `${ref.connectionId}\u0000${ref.chatId}`;
}

export function createChatTurns(): ChatTurns {
  const running = new Map<string, ChatTurn>();
  return {
    start(chat, turn) {
      const key = chatKey(chat);
      const entry = { ...turn };
      running.set(key, entry);
      return () => {
        if (running.get(key) === entry) running.delete(key);
      };
    },
    runningIn(chat) {
      return running.get(chatKey(chat));
    },
  };
}
