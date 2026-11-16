import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  clearSentChatDraft,
  loadChatDraft,
  restoreUnsentChatDraft,
  saveChatDraft,
} from "@/lib/chat-draft-storage";
import { currentAuthEpoch } from "@/lib/new-chat-draft-storage";

/**
 * The message field's text, kept as the open chat's draft: it starts from the
 * saved draft and saves every change. Sending empties the field, which
 * removes the draft. Without a `chatId` the text starts from `initialText`
 * and is kept nowhere. The draft is read once, when the field mounts; a
 * `chatId` that arrives later, as when the first send makes the chat, only
 * says where to save.
 *
 * A send can end after the field is gone, as when the guardian opens another
 * chat during an upload. `sendEnded` settles the stored draft then: an
 * accepted send removes the text that went out, a failed one puts it back.
 */
export function useChatDraftText(
  chatId: string | null | undefined,
  initialText = "",
): [string, Dispatch<SetStateAction<string>>, (text: string, accepted: boolean) => void] {
  const [authEpoch] = useState(currentAuthEpoch);
  const [text, setText] = useState(() =>
    chatId ? (loadChatDraft(chatId)?.text ?? "") : initialText,
  );
  useEffect(() => {
    if (chatId) saveChatDraft(chatId, { text }, authEpoch);
  }, [chatId, text, authEpoch]);
  // The chat this field serves, even when a first send makes it mid-upload.
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const sendEnded = useCallback(
    (sent: string, accepted: boolean) => {
      const sentFrom = chatIdRef.current;
      if (!sentFrom) return;
      if (accepted) clearSentChatDraft(sentFrom, sent);
      else restoreUnsentChatDraft(sentFrom, sent, authEpoch);
    },
    [authEpoch],
  );
  return [text, setText, sendEnded];
}
