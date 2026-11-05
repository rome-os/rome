import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { isConciergeAgent } from "../concierge/service.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { resolveWebchatLargeModelSelection, type ModelSelectionId } from "./model-selector.js";
import type { AgentSessionManager } from "../agent-sessions/index.js";
import { callerKey, type SessionCaller } from "./session-caller.js";
import type { ThreadContext } from "./types.js";

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

/**
 * The model a dashboard chat chose, for a session resumed by id. Chats restores
 * it itself: only the chat's own session reads it, and the caller names the
 * chat, or a run with no caller replies into it.
 */
export async function rememberedChatModel(
  deps: {
    webchatRepo?: Pick<WebChatRepository, "getSession">;
    sessions: Pick<AgentSessionManager, "find">;
  },
  run: {
    agentName: string;
    sessionId: string;
    caller?: SessionCaller;
    replies?: ThreadContext;
  },
): Promise<ModelSelectionId | undefined> {
  const chatId =
    run.caller?.kind === "chat"
      ? run.caller.chatId
      : !run.caller && run.replies?.channel === "webchat"
        ? run.replies.threadId
        : undefined;
  if (!chatId || !deps.webchatRepo) return undefined;
  const chat: SessionCaller = { kind: "chat", chatId };
  const stored = await deps.sessions.find(run.agentName, callerKey(chat));
  if (stored?.sessionId !== run.sessionId) return undefined;
  return chatModelSelection(deps.webchatRepo)(
    chat,
    run.agentName,
    !!(stored.provider && stored.model),
  );
}
