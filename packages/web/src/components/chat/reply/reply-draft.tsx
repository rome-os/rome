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
 * The task thread a draft sends into while the thread view is open: a message
 * of it, which the view opens on, and its task's title, which the reply bar
 * names. A reply in the view goes to the thread, never to one quoted message.
 */
export interface ReplyThread {
  thread: string;
  title: string;
}

/** A draft as a failed send puts it back: a reply to a message, or a thread to send into. */
export interface RestoredDraft {
  target?: ReplyTarget;
  thread?: ReplyThread;
}

/**
 * The reply a chat's composer holds, and the transcript's hooks for it. A
 * surface without a provider (a shared chat, a read-only viewer) offers no
 * Reply.
 */
export interface ReplyDraft {
  /** The session the composer sends to. Only its messages can be replied to. */
  sessionId: string | null;
  /** The message the reply quotes. Null while the thread view is open: a reply there goes to the thread. */
  target: ReplyTarget | null;
  /** Picks the reply and opens only the reply bar, with its quote. Inside an
   *  open thread view it changes nothing: what is sent from there goes to the
   *  thread. Sending a reply from the timeline puts it in the replied
   *  message's task thread when it is in one; any other reply is only a
   *  quote. */
  set: (target: ReplyTarget) => void;
  /** Drops the reply, and closes the thread view with it. Answers the
   *  draft's change count after it, for `restore`. */
  clear: () => number;
  /**
   * Puts a draft back after a failed send: its reply, or its thread with the
   * thread view. With `since`, the count `clear` answered when the send
   * cleared the draft, it does so only when nothing changed the draft since:
   * a reply picked, or picked and dropped again, meanwhile stays as the
   * guardian left it. Without it, only when nothing is picked.
   */
  restore: (draft: RestoredDraft, since?: number) => void;
  /** Whether the loaded transcript holds the message, so a quote can link to it. */
  has: (messageId: string) => boolean;
  jump: (messageId: string) => void;
  /**
   * Whether the chat keeps chat threads. Then an open thread view always has
   * its reply bar, while the reply bar opens on its own too: closing the reply
   * bar (its ✕, Esc, a click outside, a send) closes an open view with it.
   */
  threads: boolean;
  /** A message of the chat thread the thread view shows, or null when it is closed. While it is open, the composer sends into that thread. */
  thread: string | null;
  /** The title of the task whose thread the view shows, for the reply bar. */
  threadTitle: string | null;
  /** Opens the thread view on `thread`, a message of a task's thread, with a
   *  reply to that thread. Only a task thread's label, or a quote in it,
   *  opens it. */
  openThread: (thread: ReplyThread) => void;
  /** Closes the thread view and its reply bar: the same as `clear`. */
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

const CLOSED = { target: null, thread: null, threadTitle: null };

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
  /** The chat keeps chat threads, so it has a thread view. */
  threads?: boolean;
}): ReplyDraft {
  // The reply and the thread view are one state, so closing one closes both.
  const [draft, setDraft] = useState<{
    target: ReplyTarget | null;
    thread: string | null;
    threadTitle: string | null;
  }>(CLOSED);
  const { target, thread, threadTitle } = draft;
  const focusRef = useRef(focusComposer);
  focusRef.current = focusComposer;
  // Counts every change to the draft, so a late restore can tell whether the
  // guardian changed it after the send.
  const changes = useRef(0);

  useEffect(() => {
    changes.current += 1;
    setDraft(CLOSED);
  }, [chatId]);

  const focus = useCallback(() => requestAnimationFrame(() => focusRef.current()), []);
  const set = useCallback(
    (next: ReplyTarget) => {
      changes.current += 1;
      // Inside an open thread view the reply stays with the thread.
      setDraft((current) =>
        current.thread !== null ? current : { target: next, thread: null, threadTitle: null },
      );
      focus();
    },
    [focus],
  );
  const openThread = useCallback(
    (next: ReplyThread) => {
      if (!threads) return;
      changes.current += 1;
      setDraft({ target: null, thread: next.thread, threadTitle: next.title });
      focus();
    },
    [threads, focus],
  );
  const clear = useCallback(() => {
    changes.current += 1;
    setDraft(CLOSED);
    return changes.current;
  }, []);
  const restore = useCallback(
    (next: RestoredDraft, since?: number) => {
      if (since !== undefined && since !== changes.current) return;
      changes.current += 1;
      setDraft((current) => {
        if (current.target || current.thread !== null) return current;
        if (next.thread && threads) {
          return { target: null, thread: next.thread.thread, threadTitle: next.thread.title };
        }
        return next.target ? { target: next.target, thread: null, threadTitle: null } : current;
      });
    },
    [threads],
  );
  const closeThread = clear;
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
      threadTitle,
      openThread,
      closeThread,
    }),
    [
      sessionId,
      target,
      set,
      clear,
      restore,
      has,
      jump,
      threads,
      thread,
      threadTitle,
      openThread,
      closeThread,
    ],
  );
}
