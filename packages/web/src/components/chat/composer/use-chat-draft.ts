import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { loadChatDraft, saveChatDraft } from "@/lib/chat-draft-storage";
import { currentAuthEpoch } from "@/lib/new-chat-draft-storage";

/**
 * The message field's text, kept as the open chat's draft: it starts from the
 * saved draft and saves every change. Sending empties the field, which
 * removes the draft. Without a `chatId` the text starts from `initialText`
 * and is kept nowhere. The draft is read once, when the field mounts; a
 * `chatId` that arrives later, as when the first send makes the chat, only
 * says where to save.
 */
export function useChatDraftText(
  chatId: string | null | undefined,
  initialText = "",
): [string, Dispatch<SetStateAction<string>>] {
  const [authEpoch] = useState(currentAuthEpoch);
  const [text, setText] = useState(() =>
    chatId ? (loadChatDraft(chatId)?.text ?? "") : initialText,
  );
  useEffect(() => {
    if (chatId) saveChatDraft(chatId, { text }, authEpoch);
  }, [chatId, text, authEpoch]);
  return [text, setText];
}
