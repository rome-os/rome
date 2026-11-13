import { useEffect, type ReactNode } from "react";
import {
  ReplyDraftProvider,
  type ReplyTarget,
  type ReplyThread,
  useReplyDraftState,
} from "./reply-draft";

/** Test host that holds real reply state, as Chat does, optionally starting with a reply picked. */
export function ReplyDraftHarness({
  initial,
  thread,
  children,
}: {
  initial?: ReplyTarget;
  /** The chat keeps chat threads, and its thread view is open on this thread. */
  thread?: ReplyThread;
  children: ReactNode;
}) {
  const draft = useReplyDraftState({
    chatId: "chat-1",
    sessionId: "s1",
    messageIds: new Set(),
    jump: () => {},
    focusComposer: () => {},
    threads: thread !== undefined,
  });
  const { set, openThread } = draft;
  useEffect(() => {
    if (thread) openThread(thread);
    else if (initial) set(initial);
  }, [initial, thread, set, openThread]);
  return <ReplyDraftProvider value={draft}>{children}</ReplyDraftProvider>;
}
