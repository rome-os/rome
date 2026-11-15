import { useEffect, type ReactNode } from "react";
import { ReplyDraftProvider, type ReplyTarget, useReplyDraftState } from "./reply-draft";

/** Test host that holds real reply state, as Chat does, optionally starting with a reply picked. */
export function ReplyDraftHarness({
  initial,
  thread,
  children,
}: {
  initial?: ReplyTarget;
  /** The draft is a chat thread tab's: it sends into this thread. */
  thread?: string;
  children: ReactNode;
}) {
  const draft = useReplyDraftState({
    chatId: "chat-1",
    sessionId: "s1",
    messageIds: new Set(),
    jump: () => {},
    focusComposer: () => {},
    thread,
  });
  const { set } = draft;
  useEffect(() => {
    if (initial) set(initial);
  }, [initial, set]);
  return <ReplyDraftProvider value={draft}>{children}</ReplyDraftProvider>;
}
