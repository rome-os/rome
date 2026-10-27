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
  author: "guardian" | "agent";
  name?: string;
  /** The selected snippet, sent as `replyQuote`. Absent when the whole message is quoted. */
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
}: {
  chatId: string | undefined;
  sessionId: string | null;
  messageIds: ReadonlySet<string>;
  jump: (messageId: string) => void;
  focusComposer: () => void;
}): ReplyDraft {
  const [target, setTarget] = useState<ReplyTarget | null>(null);
  const focusRef = useRef(focusComposer);
  focusRef.current = focusComposer;

  useEffect(() => setTarget(null), [chatId]);

  const set = useCallback((next: ReplyTarget) => {
    setTarget(next);
    requestAnimationFrame(() => focusRef.current());
  }, []);
  const clear = useCallback(() => setTarget(null), []);
  const restore = useCallback((next: ReplyTarget) => setTarget((current) => current ?? next), []);
  const has = useCallback((messageId: string) => messageIds.has(messageId), [messageIds]);

  return useMemo(
    () => ({ sessionId, target, set, clear, restore, has, jump }),
    [sessionId, target, set, clear, restore, has, jump],
  );
}
