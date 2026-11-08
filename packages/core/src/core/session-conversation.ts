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

type ChatRow = { id: string; name: string; type: string } | null;

async function readChat(
  read: () => Promise<ChatRow>,
  context: Record<string, string>,
): Promise<SessionChat | undefined> {
  let chat: ChatRow;
  try {
    chat = await read();
  } catch (err) {
    // The lookup only refines where turns record, so it must not fail the turn.
    log.warn("failed to read the chat that has a session", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  if (!chat) return undefined;
  const { id, name, type } = chat;
  return { id, name, type: type as RomeSessionType };
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
  return await readChat(() => webchatRepo.chatOfSession(sessionId), { sessionId });
}

/** The chat with this id, while it still exists. A failed read counts as no chat. */
export async function findChat(
  webchatRepo: Pick<WebChatRepository, "getSession"> | undefined,
  chatId: string,
): Promise<SessionChat | undefined> {
  if (!webchatRepo) return undefined;
  return await readChat(() => webchatRepo.getSession(chatId), { chatId });
}

// Temporary, until ZHA-157 decides where a turn records when its caller names
// no chat. An open session's later turns that name no chat record into the
// chat its opener named, as they did when the session held that chat itself.
// Kept per open session in this process, so a reopened session forgets it.
const openerChats = new WeakMap<object, string | undefined>();

/** Note the chat the caller that opened `session` named, if any. Only the first note counts. */
export function noteOpenerChat(session: object, chatId: string | undefined): void {
  if (!openerChats.has(session)) openerChats.set(session, chatId);
}

/** The chat the caller that opened `session` named, while it stays open. */
export function openerChat(session: object): string | undefined {
  return openerChats.get(session);
}
