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
  /** Picks the reply and opens only the reply bar. The thread view stays as
   *  it is: open when the reply is picked inside it, else closed. Sending the
   *  reply puts it in the replied message's task thread when it is in one;
   *  any other reply is only a quote. */
  set: (target: ReplyTarget) => void;
  /** Drops the reply, and closes the thread view with it. Answers the
   *  draft's change count after it, for `restore`. */
  clear: () => number;
  /**
   * Puts a reply back after a failed send, with its thread view when
   * `thread` names the one it was sent from. With
   * `since`, the count `clear` answered when the send cleared the draft, it
   * does so only when nothing changed the draft since: a reply picked, or
   * picked and dropped again, meanwhile stays as the guardian left it.
   * Without it, only when no reply is picked.
   */
  restore: (target: ReplyTarget, since?: number, thread?: string) => void;
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
  /** Opens the thread view on `target`'s task thread, with `target` as the
   *  reply. Only a task thread's label, or a quote in it, opens it. */
  openThread: (target: ReplyTarget) => void;
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

const CLOSED = { target: null, thread: null };

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
  const [draft, setDraft] = useState<{ target: ReplyTarget | null; thread: string | null }>(CLOSED);
  const { target, thread } = draft;
  const focusRef = useRef(focusComposer);
  focusRef.current = focusComposer;
  // Counts every change to the draft, so a late restore can tell whether the
  // guardian changed it after the send.
  const changes = useRef(0);

  useEffect(() => {
    changes.current += 1;
    setDraft(CLOSED);
  }, [chatId]);

  // The one place the reply bar opens, with the thread view when `openView`
  // says so and the chat keeps chat threads.
  const opened = useCallback(
    (next: ReplyTarget, openView: boolean) => ({
      target: next,
      thread: threads && openView ? next.messageId : null,
    }),
    [threads],
  );
  const pick = useCallback(
    (next: ReplyTarget, openView?: boolean) => {
      changes.current += 1;
      // A reply picked inside an open thread view keeps it open: the view
      // shows its whole thread, older than the loaded timeline too. One picked
      // from the timeline opens no view.
      setDraft((current) => opened(next, openView ?? current.thread !== null));
      requestAnimationFrame(() => focusRef.current());
    },
    [opened],
  );
  const set = useCallback((next: ReplyTarget) => pick(next), [pick]);
  const clear = useCallback(() => {
    changes.current += 1;
    setDraft(CLOSED);
    return changes.current;
  }, []);
  const restore = useCallback(
    (next: ReplyTarget, since?: number, thread?: string) => {
      if (since !== undefined && since !== changes.current) return;
      changes.current += 1;
      setDraft((current) =>
        current.target
          ? current
          : thread
            ? { target: next, thread: threads ? thread : null }
            : opened(next, false),
      );
    },
    [opened, threads],
  );
  const openThread = useCallback((next: ReplyTarget) => pick(next, true), [pick]);
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
      openThread,
      closeThread,
    }),
    [sessionId, target, set, clear, restore, has, jump, threads, thread, openThread, closeThread],
  );
}
