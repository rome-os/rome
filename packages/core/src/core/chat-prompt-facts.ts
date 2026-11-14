import type { PromptFacts } from "../agent/index.js";
import type { SenderLabels } from "../chats/sender-labels.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import { contextOf, type TurnLinks } from "../sessions/turn-links.js";
import { type ChannelSurfaces, surfaceOf } from "./session-opening.js";

export interface ChatPromptFactsDeps {
  /** What was said in each chat that a session has not seen. */
  facts: Pick<TurnLinks, "unseen" | "seen">;
  /** The messages Chats holds, by id. */
  messages: Pick<MessageRepository, "byIds">;
  /** Who said each message, as the agent reads it. */
  labels: Pick<SenderLabels, "read" | "readUnseen">;
  /** The channel that opened a chat, or null for a chat no channel opened. */
  channelOfChat: (chatId: string) => string | null;
  channelSurface: ChannelSurfaces;
}

/**
 * The prompt facts, answering that a session catches up on nothing in a chat
 * whose channel already hands the agent every message, as web chat does.
 */
export function chatPromptFacts(deps: ChatPromptFactsDeps): PromptFacts {
  return {
    async unseen(chatId) {
      const channel = deps.channelOfChat(chatId);
      if (channel && !surfaceOf(deps.channelSurface, channel).promptContext) return null;
      return deps.labels.readUnseen(deps.facts.unseen(chatId));
    },
    read: async (messageIds) => deps.labels.read(deps.messages.byIds(messageIds).map(contextOf)),
    seen: (messageIds, chatId, turnId) => deps.facts.seen(messageIds, chatId, turnId),
  };
}
