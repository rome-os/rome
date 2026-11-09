import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** The message a draft replies to, as the chip and the optimistic bubble show it. */
export interface ReplyTarget {
  messageId: string;
  author: "guardian" | "agent" | "automated";
  name?: string;
  /** The selected snippet, or the text of the one bubble replied to in a message of several. Sent as `replyQuote`. Absent when the whole message is quoted. */
  quote?: string;
  /** What the chip and the optimistic bubble show: the quote, or the message's text. */
  preview: string;
}

/**
 * The reply a chat's composer holds, and the transcript's hooks for it. A
 * surface without a provider (a shared chat, a read-only viewer) offers no
 * Reply.
 */
export interface ReplyDraft {
  /** The session the composer sends to. Only its messages can be replied to. */
  sessionId: string | null;
  target: ReplyTarget | null;
  set: (target: ReplyTarget) => void;
  clear: () => void;
  /** Puts a target back after a failed send, unless the guardian has picked another meanwhile. */
  restore: (target: ReplyTarget) => void;
  /** Whether the loaded transcript holds the message, so a quote can link to it. */
  has: (messageId: string) => boolean;
  jump: (messageId: string) => void;
  /** Whether the chat keeps chat threads, so a reply or a quote opens its thread view. */
  threads: boolean;
  /** A message of the chat thread the thread view shows, or null when it is closed. While it is open, the composer sends into that thread. */
  thread: string | null;
  openThread: (messageId: string) => void;
  /** Closes the thread view, and drops the reply with it. */
  closeThread: () => void;
}

/** The form fields that carry a reply to the server. */
export function replyFormFields(target: ReplyTarget): Record<string, string> {
  return {
    replyToMessageId: target.messageId,
    ...(target.quote ? { replyQuote: target.quote } : {}),
  };
}

const ReplyDraftContext = createContext<ReplyDraft | null>(null);

export const ReplyDraftProvider = ReplyDraftContext.Provider;

export function useReplyDraft(): ReplyDraft | null {
  return useContext(ReplyDraftContext);
}

/**
 * The draft state for one chat. The reply is dropped when `chatId` changes.
 * Picking a reply focuses the composer through `focusComposer`.
 */
export function useReplyDraftState({
  chatId,
  sessionId,
  messageIds,
  jump,
  focusComposer,
  threads = false,
}: {
  chatId: string | undefined;
  sessionId: string | null;
  messageIds: ReadonlySet<string>;
  jump: (messageId: string) => void;
  focusComposer: () => void;
  /** The chat keeps chat threads: a reply opens its thread view. */
  threads?: boolean;
}): ReplyDraft {
  const [target, setTarget] = useState<ReplyTarget | null>(null);
  const [thread, setThread] = useState<string | null>(null);
  const focusRef = useRef(focusComposer);
  focusRef.current = focusComposer;

  useEffect(() => {
    setTarget(null);
    setThread(null);
  }, [chatId]);

  const set = useCallback(
    (next: ReplyTarget) => {
      setTarget(next);
      if (threads) setThread(next.messageId);
      requestAnimationFrame(() => focusRef.current());
    },
    [threads],
  );
  const openThread = useCallback((messageId: string) => setThread(messageId), []);
  const closeThread = useCallback(() => {
    setThread(null);
    setTarget(null);
  }, []);
  const clear = useCallback(() => setTarget(null), []);
  const restore = useCallback((next: ReplyTarget) => setTarget((current) => current ?? next), []);
  const has = useCallback((messageId: string) => messageIds.has(messageId), [messageIds]);

  return useMemo(
    () => ({
      sessionId,
      target,
      set,
      clear,
      restore,
      has,
      jump,
      threads,
      thread,
      openThread,
      closeThread,
    }),
    [sessionId, target, set, clear, restore, has, jump, threads, thread, openThread, closeThread],
  );
}
