import type { VoiceConversationState } from "@rome/api-types/voice-conversation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceConversationInfo } from "@/hooks/use-voice-conversation-info";
import { shellAllowsMicrophone } from "@/lib/electron-shell";
import {
  type ConversationStopReason,
  startVoiceConversation,
  type VoiceConversation,
} from "@/lib/voice-conversation/conversation";

/**
 * A voice conversation in `chatId`, run from the composer. The composer offers
 * it only where `available` holds; Rome checks the chat again when it starts.
 * `onUnsent` gets the guardian's words a conversation ended before sending.
 */
export function useVoiceConversation({
  chatId,
  onUnsent,
}: {
  chatId: string | null | undefined;
  onUnsent?: (text: string) => void;
}) {
  const onUnsentRef = useRef(onUnsent);
  onUnsentRef.current = onUnsent;
  const info = useVoiceConversationInfo();
  const conversationRef = useRef<VoiceConversation | null>(null);
  const [active, setActive] = useState(false);
  const [state, setState] = useState<VoiceConversationState>("listening");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [asking, setAsking] = useState(false);
  const [stopped, setStopped] = useState<ConversationStopReason | null>(null);

  const start = useCallback(() => {
    if (!chatId || conversationRef.current) return;
    setStopped(null);
    setState("listening");
    setMuted(false);
    mutedRef.current = false;
    setActive(true);
    conversationRef.current = startVoiceConversation(chatId, {
      onState: setState,
      onAsking: setAsking,
      onEnded: (reason, unsent) => {
        conversationRef.current = null;
        setActive(false);
        setAsking(false);
        setMuted(false);
        mutedRef.current = false;
        setStopped(reason);
        if (unsent) onUnsentRef.current?.(unsent);
      },
    });
  }, [chatId]);

  const end = useCallback(() => conversationRef.current?.end(), []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    conversationRef.current?.setMuted(next);
    setMuted(next);
  }, []);

  // Leaving the chat, or the page, ends its conversation.
  useEffect(() => () => conversationRef.current?.end(), [chatId]);

  // The bars follow whoever is talking: Rome while it speaks, the guardian otherwise.
  const level = useCallback(() => {
    const conversation = conversationRef.current;
    if (!conversation) return 0;
    return state === "speaking" ? conversation.replyLevel() : conversation.micLevel();
  }, [state]);

  return {
    /** False hides the voice conversation button: the account is off the voice input list, or this is no chat yet. */
    available: Boolean(info.data?.available) && Boolean(chatId) && shellAllowsMicrophone(),
    active,
    state,
    muted,
    /** True while the browser asks the guardian for the microphone. */
    asking,
    /** Why the last conversation ended on its own, or null. */
    stopped,
    dismissStopped: useCallback(() => setStopped(null), []),
    start,
    end,
    toggleMute,
    level,
  };
}
