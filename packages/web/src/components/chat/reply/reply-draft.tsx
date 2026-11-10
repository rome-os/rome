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
  /** Picks the reply. In a chat that keeps chat threads it also opens the
   *  thread view, when the replied message is in a chat thread. A reply to a
   *  message in none stays in the chat's timeline, and sending it starts the
   *  message's thread. */
  set: (target: ReplyTarget) => void;
  /** Drops the reply, and closes the thread view with it. Answers the
   *  draft's change count after it, for `restore`. */
  clear: () => number;
  /**
   * Puts a reply back, with its thread view, after a failed send. With
   * `since`, the count `clear` answered when the send cleared the draft, it
   * does so only when nothing changed the draft since: a reply picked, or
   * picked and dropped again, meanwhile stays as the guardian left it.
   * Without it, only when no reply is picked.
   */
  restore: (target: ReplyTarget, since?: number) => void;
  /** Whether the loaded transcript holds the message, so a quote can link to it. */
  has: (messageId: string) => boolean;
  jump: (messageId: string) => void;
  /**
   * Whether the chat keeps chat threads. Then an open thread view always has
   * its reply bar: closing either (the reply bar's ✕, Esc, a click outside, a
   * send) closes both.
   */
  threads: boolean;
  /** A message of the chat thread the thread view shows, or null when it is closed. While it is open, the composer sends into that thread. */
  thread: string | null;
  /** Opens the thread view on `target`'s thread, with `target` as the reply. */
  openThread: (target: ReplyTarget) => void;
  /** Closes the thread view and the reply bar together: the same as `clear`. */
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
  inThread = () => true,
}: {
  chatId: string | undefined;
  sessionId: string | null;
  messageIds: ReadonlySet<string>;
  jump: (messageId: string) => void;
  focusComposer: () => void;
  /** The chat keeps chat threads: a reply opens its thread view. */
  threads?: boolean;
  /** Whether a message is in a chat thread, as the loaded timeline shows it. */
  inThread?: (messageId: string) => boolean;
}): ReplyDraft {
  // The reply and the thread view are one state, so they change together.
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

  const inThreadRef = useRef(inThread);
  inThreadRef.current = inThread;
  // The one place the reply bar and the thread view open: in a chat that
  // keeps chat threads, a reply to a message in a thread opens that thread
  // too, and `openThread` always does.
  const opened = useCallback(
    (next: ReplyTarget, openView = inThreadRef.current(next.messageId)) => ({
      target: next,
      thread: threads && openView ? next.messageId : null,
    }),
    [threads],
  );
  const pick = useCallback(
    (next: ReplyTarget, openView?: boolean) => {
      changes.current += 1;
      setDraft(opened(next, openView));
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
    (next: ReplyTarget, since?: number) => {
      if (since !== undefined && since !== changes.current) return;
      changes.current += 1;
      setDraft((current) => (current.target ? current : opened(next)));
    },
    [opened],
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
