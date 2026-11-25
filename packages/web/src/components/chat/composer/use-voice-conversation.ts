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
 * `onTurn` hears of each turn Rome sends to the chat, and the message it is.
 * `onUnsent` gets the guardian's words a conversation ended before sending.
 * `onStopped` hears why a conversation ended on its own.
 */
export function useVoiceConversation({
  chatId,
  onTurn,
  onUnsent,
  onStopped,
}: {
  chatId: string | null | undefined;
  onTurn?: (text: string, inputId: string) => void;
  onUnsent?: (text: string) => void;
  onStopped?: (reason: ConversationStopReason) => void;
}) {
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;
  const onTurnRef = useRef(onTurn);
  onTurnRef.current = onTurn;
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
  const [heard, setHeard] = useState("");
  const [caption, setCaption] = useState("");

  const start = useCallback(() => {
    if (!chatId || conversationRef.current) return;
    setStopped(null);
    setState("listening");
    setMuted(false);
    mutedRef.current = false;
    setHeard("");
    setCaption("");
    setActive(true);
    conversationRef.current = startVoiceConversation(chatId, {
      onState: setState,
      onAsking: setAsking,
      onHeard: setHeard,
      onCaption: setCaption,
      onTurn: (text, inputId) => onTurnRef.current?.(text, inputId),
      onEnded: (reason, unsent) => {
        conversationRef.current = null;
        setActive(false);
        setAsking(false);
        setMuted(false);
        mutedRef.current = false;
        setStopped(reason);
        if (unsent) onUnsentRef.current?.(unsent);
        if (reason) onStoppedRef.current?.(reason);
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
    /** What Rome has heard of the guardian's turn, not sent yet. */
    heard,
    /** The reply's sentence playing now. */
    caption,
    /** Why the last conversation ended on its own, or null. */
    stopped,
    dismissStopped: useCallback(() => setStopped(null), []),
    start,
    end,
    toggleMute,
    level,
  };
}
