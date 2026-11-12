import { useEffect, type ReactNode } from "react";
import { ReplyDraftProvider, useReplyDraftState, type ReplyTarget } from "./reply-draft";

/** Test host that holds real reply state, as Chat does, optionally starting with a reply picked. */
export function ReplyDraftHarness({
  initial,
  threads = false,
  children,
}: {
  initial?: ReplyTarget;
  /** The chat keeps chat threads, and the reply is picked from its thread view, open on it. */
  threads?: boolean;
  children: ReactNode;
}) {
  const draft = useReplyDraftState({
    chatId: "chat-1",
    sessionId: "s1",
    messageIds: new Set(),
    jump: () => {},
    focusComposer: () => {},
    threads,
  });
  const { set, openThread } = draft;
  useEffect(() => {
    if (initial) (threads ? openThread : set)(initial);
  }, [initial, set, openThread, threads]);
  return <ReplyDraftProvider value={draft}>{children}</ReplyDraftProvider>;
}
