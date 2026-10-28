import { useEffect, type ReactNode } from "react";
import { ReplyDraftProvider, useReplyDraftState, type ReplyTarget } from "./reply-draft";

/** Test host that holds real reply state, as Chat does, optionally starting with a reply picked. */
export function ReplyDraftHarness({
  initial,
  children,
}: {
  initial?: ReplyTarget;
  children: ReactNode;
}) {
  const draft = useReplyDraftState({
    chatId: "chat-1",
    sessionId: "s1",
    messageIds: new Set(),
    jump: () => {},
    focusComposer: () => {},
  });
  const { set } = draft;
  useEffect(() => {
    if (initial) set(initial);
  }, [initial, set]);
  return <ReplyDraftProvider value={draft}>{children}</ReplyDraftProvider>;
}
