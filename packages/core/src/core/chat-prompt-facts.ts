import type { PromptFacts } from "../agent/index.js";
import { type ChannelSurfaces, surfaceOf } from "./session-opening.js";

export interface ChatPromptFactsDeps {
  /** What was said in each chat that a session has not seen. */
  facts: PromptFacts;
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
    unseen(chatId) {
      const channel = deps.channelOfChat(chatId);
      if (channel && !surfaceOf(deps.channelSurface, channel).promptContext) return null;
      return deps.facts.unseen(chatId);
    },
    seen: (messageIds, chatId, turnId) => deps.facts.seen(messageIds, chatId, turnId),
  };
}
