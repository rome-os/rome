import { z } from "zod";
import { currentAuthEpoch } from "./new-chat-draft-storage";

// One draft per open chat, kept in local storage so it survives a reload and
// a switch to another chat. It holds text only: an attachment or a pick does
// not survive. Logging out removes every draft.
const PREFIX = "rome:chat-draft:";
const recordSchema = z.object({
  version: z.literal(1),
  text: z.string(),
  authEpoch: z.string(),
});
export interface ChatDraft {
  text: string;
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
    return { text: result.data.text };
  } catch {
    return null;
  }
}

/**
 * Saves `draft` for the chat, or removes it when the text is empty. A tab
 * that was open across a logout passes the epoch it loaded under, and saves
 * nothing.
 */
export function saveChatDraft(chatId: string, draft: ChatDraft, authEpoch: string | null) {
  if (!draft.text) {
    clearChatDraft(chatId);
    return;
  }
  try {
    if (authEpoch === null || authEpoch !== currentAuthEpoch()) return;
    localStorage.setItem(
      PREFIX + chatId,
      JSON.stringify({ version: 1, text: draft.text, authEpoch }),
    );
  } catch {
    // Full or disabled storage must not break typing.
  }
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
