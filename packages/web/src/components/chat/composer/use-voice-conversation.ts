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
 * A draft with `startChat` offers it too: starting creates the chat.
 */
export function useVoiceConversation({
  chatId,
  startChat,
}: {
  chatId: string | null | undefined;
  startChat?: () => Promise<string>;
}) {
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
    const chat = chatId || startChat;
    if (!chat || conversationRef.current) return;
    setStopped(null);
    setState("listening");
    setMuted(false);
    mutedRef.current = false;
    setHeard("");
    setCaption("");
    setActive(true);
    conversationRef.current = startVoiceConversation(chat, {
      onState: setState,
      onAsking: setAsking,
      onHeard: setHeard,
      onCaption: setCaption,
      onEnded: (reason) => {
        conversationRef.current = null;
        setActive(false);
        setAsking(false);
        setMuted(false);
        mutedRef.current = false;
        setStopped(reason);
      },
    });
  }, [chatId, startChat]);

  const end = useCallback(() => conversationRef.current?.end(), []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    conversationRef.current?.setMuted(next);
    setMuted(next);
  }, []);

  // Leaving the chat, or the page, ends its conversation. A draft turning
  // into the chat its conversation created stays in it.
  const chatIdRef = useRef(chatId);
  useEffect(() => {
    if (chatIdRef.current && chatIdRef.current !== chatId) conversationRef.current?.end();
    chatIdRef.current = chatId;
  }, [chatId]);
  useEffect(() => () => conversationRef.current?.end(), []);

  // The bars follow whoever is talking: Rome while it speaks, the guardian otherwise.
  const level = useCallback(() => {
    const conversation = conversationRef.current;
    if (!conversation) return 0;
    return state === "speaking" ? conversation.replyLevel() : conversation.micLevel();
  }, [state]);

  return {
    /** False hides the voice conversation button: the account is off the voice input list, or this is no chat yet and cannot start one. */
    available:
      Boolean(info.data?.available) && Boolean(chatId || startChat) && shellAllowsMicrophone(),
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
