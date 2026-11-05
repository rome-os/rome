import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { isConciergeAgent } from "../concierge/service.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { resolveWebchatLargeModelSelection, type ModelSelectionId } from "./model-selector.js";
import type { SessionCaller } from "./session-caller.js";

/**
 * The model a dashboard chat chose, which a resumed session of that chat
 * restores. A pinned session keeps its pin, except the Concierge's own chat,
 * whose quota failover applies to background turns too
 * (docs/adrs/concierge-quota-failover.md). Only the chat's own session reads
 * it: a subagent or fork under the chat is another caller.
 */
export function chatModelSelection(webchatRepo: Pick<WebChatRepository, "getSession"> | undefined) {
  return async (
    caller: SessionCaller,
    agentName: string,
    pinned: boolean,
  ): Promise<ModelSelectionId | undefined> => {
    if (caller.kind !== "chat" || !webchatRepo) return undefined;
    if (pinned && !(caller.chatId === CONCIERGE_CHAT_ID && isConciergeAgent(agentName))) {
      return undefined;
    }
    return resolveWebchatLargeModelSelection(
      (await webchatRepo.getSession(caller.chatId))?.largeModelSelection,
    )?.id;
  };
}
