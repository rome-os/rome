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
 * A task's chat thread, as the thread tab opens on it: a message of the
 * thread and its task's title, which the tab's header shows.
 */
export interface ReplyThread {
  thread: string;
  title: string;
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
  /** Picks the reply and opens the reply bar with its quote. Sending a reply
   *  from the chat's timeline puts it in the replied message's task thread
   *  when it is in one; any other reply is only a quote. */
  set: (target: ReplyTarget) => void;
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
  /** Whether the loaded transcript holds the message, so a quote can link to it. */
  has: (messageId: string) => boolean;
  jump: (messageId: string) => void;
  /** Whether the chat keeps chat threads: only then can a thread be opened. */
  threads: boolean;
  /** A message of the chat thread this draft sends into, or null when it sends to the chat itself. */
  thread: string | null;
  /** Opens the chat's thread tab on `thread`, a message of a task's thread. Only a task thread's label, or a quote in it, opens it. */
  openThread: (thread: ReplyThread) => void;
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
 * With `thread`, the draft sends into that chat thread, and the thread's own
 * composer holds it; without it, the draft is the chat's own. A chat that
 * keeps chat threads passes `onOpenThread`.
 */
export function useReplyDraftState({
  chatId,
  sessionId,
  messageIds,
  jump,
  focusComposer,
  onOpenThread,
  thread = null,
}: {
  chatId: string | undefined;
  sessionId: string | null;
  messageIds: ReadonlySet<string>;
  jump: (messageId: string) => void;
  focusComposer: () => void;
  onOpenThread?: (thread: ReplyThread) => void;
  thread?: string | null;
}): ReplyDraft {
  const [target, setTarget] = useState<ReplyTarget | null>(null);
  const focusRef = useRef(focusComposer);
  focusRef.current = focusComposer;
  const openRef = useRef(onOpenThread);
  openRef.current = onOpenThread;
  const threads = onOpenThread !== undefined;
  // Counts every change to the draft, so a late restore can tell whether the
  // guardian changed it after the send.
  const changes = useRef(0);

  useEffect(() => {
    changes.current += 1;
    setTarget(null);
  }, [chatId]);

  const focus = useCallback(() => requestAnimationFrame(() => focusRef.current()), []);
  const set = useCallback(
    (next: ReplyTarget) => {
      changes.current += 1;
      setTarget(next);
      focus();
    },
    [focus],
  );
  const openThread = useCallback((next: ReplyThread) => openRef.current?.(next), []);
  const clear = useCallback(() => {
    changes.current += 1;
    setTarget(null);
    return changes.current;
  }, []);
  const restore = useCallback((next: ReplyTarget, since?: number) => {
    if (since !== undefined && since !== changes.current) return;
    changes.current += 1;
    setTarget((current) => current ?? next);
  }, []);
  const has = useCallback((messageId: string) => messageIds.has(messageId), [messageIds]);

  return useMemo(
    () => ({ sessionId, target, set, clear, restore, has, jump, threads, thread, openThread }),
    [sessionId, target, set, clear, restore, has, jump, threads, thread, openThread],
  );
}
