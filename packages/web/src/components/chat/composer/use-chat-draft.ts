import { useCallback, useEffect, useRef, useState } from "react";
import { loadChatDraft, saveChatDraft } from "@/lib/chat-draft-storage";
import { currentAuthEpoch } from "@/lib/new-chat-draft-storage";
import type { DictationStop } from "@/lib/voice-input/dictation";

/**
 * The message field's text and its voice input notice, kept as the open
 * chat's draft: both start from the saved draft and every change is saved.
 * Sending empties the field, which removes the draft. Without a `chatId` the
 * text starts from `initialText` and is kept nowhere. The draft is read once,
 * when the field mounts; a `chatId` that arrives later, as when the first send
 * makes the chat, only says where to save.
 */
export function useChatDraft(chatId: string | null | undefined, initialText = "") {
  const [authEpoch] = useState(currentAuthEpoch);
  const [saved] = useState(() => (chatId ? loadChatDraft(chatId) : null));
  const [text, setText] = useState(saved ? saved.text : initialText);
  const [notice, setNotice] = useState<DictationStop | null>(saved?.stop ?? null);
  const latest = useRef({ chatId, text });
  latest.current = { chatId, text };
  useEffect(() => {
    if (chatId) saveChatDraft(chatId, { text, stop: notice }, authEpoch);
  }, [chatId, text, notice, authEpoch]);
  /** Saves `stop` with the latest text at once, for a field that is going away. */
  const keepNotice = useCallback(
    (stop: DictationStop) => {
      const { chatId, text } = latest.current;
      if (chatId) saveChatDraft(chatId, { text, stop }, authEpoch);
    },
    [authEpoch],
  );
  return { text, setText, notice, setNotice, keepNotice };
}
