import type { RomeSessionType } from "@rome-os/app-runtime";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";

const log = createLogger("session-conversation");

export interface RecordedConversation {
  id: string;
  name: string;
  type: RomeSessionType;
}

/**
 * The conversation a session's row recorded, when it still exists. A deleted
 * conversation leaves its id on the row, and recording under that id would
 * recreate it.
 */
export async function findRecordedConversation(
  webchatRepo: WebChatRepository | undefined,
  chatId: string | undefined,
): Promise<RecordedConversation | undefined> {
  if (!webchatRepo || !chatId) return undefined;
  let conversation;
  try {
    conversation = await webchatRepo.getSession(chatId);
  } catch (err) {
    // The lookup only refines where turns record, so it must not fail the session.
    log.warn("failed to read a session's recorded conversation", {
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  if (!conversation) return undefined;
  const { id, name, type } = conversation;
  return { id, name, type: type as RomeSessionType };
}

/**
 * The conversation a session serves. A `named` one was passed in by the
 * caller that opened the session. A `recorded` one is the conversation the
 * session's row stored, looked up only when no caller named one and only if it
 * still exists.
 */
export type SessionConversation =
  | { origin: "named"; id: string }
  | ({ origin: "recorded" } & RecordedConversation);
