import { z } from "zod";
import { type DictationStop, dictationStopReasonSchema } from "./voice-input/dictation";
import { currentAuthEpoch } from "./new-chat-draft-storage";

// One draft per open chat, kept in local storage so it survives a reload and
// a switch to another chat. It holds the field's text and, when listening
// stopped on its own, why. Text only: an attachment or a pick does not
// survive. Logging out removes every draft, and deleting a chat removes its
// own. Local, not session, storage on purpose: a draft outlives its tab,
// unlike the new chat's draft in `new-chat-draft-storage.ts`.
const PREFIX = "rome:chat-draft:";
const recordSchema = z.object({
  version: z.literal(1),
  text: z.string(),
  // Optional, so drafts saved before stops were kept still load. A reason a
  // later release no longer knows drops only the notice, never the text.
  stop: z
    .object({ reason: dictationStopReasonSchema, detail: z.string().optional() })
    .nullable()
    .optional()
    .catch(null),
  authEpoch: z.string(),
});
export interface ChatDraft {
  text: string;
  /** Why listening last stopped on its own, until the next edit or send. */
  stop: DictationStop | null;
}

export function loadChatDraft(chatId: string): ChatDraft | null {
  try {
    const result = recordSchema.safeParse(
      JSON.parse(localStorage.getItem(PREFIX + chatId) ?? "null"),
    );
    if (!result.success) return null;
    if (result.data.authEpoch !== currentAuthEpoch()) {
      clearChatDraft(chatId);
      return null;
    }
    return { text: result.data.text, stop: result.data.stop ?? null };
  } catch {
    return null;
  }
}

/**
 * Saves `draft` for the chat, or removes it when it holds nothing. A tab that
 * was open across a logout passes the epoch it loaded under, and saves
 * nothing.
 */
export function saveChatDraft(chatId: string, draft: ChatDraft, authEpoch: string | null) {
  try {
    if (authEpoch === null || authEpoch !== currentAuthEpoch()) return;
    if (!draft.text && !draft.stop) {
      clearChatDraft(chatId);
      return;
    }
    localStorage.setItem(
      PREFIX + chatId,
      JSON.stringify({ version: 1, text: draft.text, stop: draft.stop, authEpoch }),
    );
  } catch {
    // Full or disabled storage must not break typing.
  }
}

/**
 * After a send the server accepted: removes the draft only while it is still
 * the text that went out, so anything typed since stays.
 */
export function clearSentChatDraft(chatId: string, sent: string) {
  if (loadChatDraft(chatId)?.text === sent) clearChatDraft(chatId);
}

/**
 * After a send that failed: puts the text back as the draft, unless the chat
 * has newer text or a logout came in between. A saved reason stays.
 */
export function restoreUnsentChatDraft(chatId: string, text: string, authEpoch: string | null) {
  const current = loadChatDraft(chatId);
  if (current?.text) return;
  saveChatDraft(chatId, { text, stop: current?.stop ?? null }, authEpoch);
}

export function clearChatDraft(chatId: string) {
  try {
    localStorage.removeItem(PREFIX + chatId);
  } catch {
    // Disabled storage must not break sending.
  }
}

export function clearAllChatDrafts() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Disabled storage must not break logout.
  }
}
