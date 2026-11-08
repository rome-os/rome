import type { RomeSessionType } from "@rome-os/app-runtime";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";

const log = createLogger("session-conversation");

/** The chat that has a session, as the web chat side holds it. */
export interface SessionChat {
  id: string;
  name: string;
  type: RomeSessionType;
}

/**
 * Which chat has this session, asked by the session's id. Participation owns
 * the question; the web chat side answers it until Participation has the
 * query. A failed read counts as no chat.
 */
export async function findSessionChat(
  webchatRepo: Pick<WebChatRepository, "chatOfSession"> | undefined,
  sessionId: string,
): Promise<SessionChat | undefined> {
  if (!webchatRepo) return undefined;
  let chat;
  try {
    chat = await webchatRepo.chatOfSession(sessionId);
  } catch (err) {
    // The lookup only refines where turns record, so it must not fail the turn.
    log.warn("failed to read the chat that has a session", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  if (!chat) return undefined;
  const { id, name, type } = chat;
  return { id, name, type: type as RomeSessionType };
}
