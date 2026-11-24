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
  /** The message the reply quotes. */
  target: ReplyTarget | null;
  /** Picks the reply and opens the reply bar with its quote. With `quiet` the composer does not take focus. */
  set: (target: ReplyTarget, options?: { quiet?: boolean }) => void;
  /** Drops the reply. Answers the draft's change count after it, for `restore`. */
  clear: () => number;
  /**
   * Puts a reply back after a failed send. With `since`, the count `clear`
   * answered when the send cleared the draft, it does so only when nothing
   * changed the draft since: a reply picked, or picked and dropped again,
   * meanwhile stays as the guardian left it. Without it, only when nothing is
   * picked.
   */
  restore: (target: ReplyTarget, since?: number) => void;
  /**
   * What pressing a quote does. `messageId` is the message quoted and `from`
   * the one that carries the quote. Absent, as in a chain in focus, the quote
   * is plain text.
   */
  jump?: (messageId: string, from: string) => void;
  /** What the reply bar's × does. Defaults to `clear`. */
  dismiss?: () => void;
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
 * The draft state for one composer. The reply is dropped when `chatId`
 * changes. Picking a reply focuses the composer through `focusComposer`.
 */
export function useReplyDraftState({
  chatId,
  sessionId,
  jump,
  onDismiss,
  focusComposer,
}: {
  chatId: string | undefined;
  sessionId: string | null;
  jump: (messageId: string, from: string) => void;
  /** Runs after the reply bar's × drops the reply. */
  onDismiss?: () => void;
  focusComposer: () => void;
}): ReplyDraft {
  const [target, setTarget] = useState<ReplyTarget | null>(null);
  const focusRef = useRef(focusComposer);
  focusRef.current = focusComposer;
  // Counts every change to the draft, so a late restore can tell whether the
  // guardian changed it after the send.
  const changes = useRef(0);

  useEffect(() => {
    changes.current += 1;
    setTarget(null);
  }, [chatId]);

  const focus = useCallback(() => requestAnimationFrame(() => focusRef.current()), []);
  const set = useCallback(
    (next: ReplyTarget, options?: { quiet?: boolean }) => {
      changes.current += 1;
      setTarget(next);
      if (!options?.quiet) focus();
    },
    [focus],
  );
  const clear = useCallback(() => {
    changes.current += 1;
    setTarget(null);
    return changes.current;
  }, []);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const dismiss = useCallback(() => {
    clear();
    dismissRef.current?.();
  }, [clear]);
  const restore = useCallback((next: ReplyTarget, since?: number) => {
    if (since !== undefined && since !== changes.current) return;
    changes.current += 1;
    setTarget((current) => current ?? next);
  }, []);

  return useMemo(
    () => ({
      sessionId,
      target,
      set,
      clear,
      restore,
      jump,
      dismiss,
    }),
    [sessionId, target, set, clear, restore, jump, dismiss],
  );
}
