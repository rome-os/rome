// The chat threads of a Concierge chat as its main transcript offers them
// (docs/domains/chats.md#chat-thread): how many replies each thread's first
// message has. The thread view's own transcript has no provider, so it shows
// no replies line.

import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { ChatMessage } from "@/lib/chat-types";
import { cn } from "@/lib/utils";
import { useReplyDraft } from "./reply-draft";
import { replyPreview } from "./reply-source";

export interface ChatThreads {
  /** Replies per thread, keyed by the id of the thread's first message. */
  replies: ReadonlyMap<string, number>;
}

const ChatThreadsContext = createContext<ChatThreads | null>(null);

export const ChatThreadsProvider = ChatThreadsContext.Provider;

/** The chat threads of the transcript this renders in, or null inside the thread view. */
export function useChatThreads(): ChatThreads | null {
  return useContext(ChatThreadsContext);
}

/**
 * How many replies each chat thread has, keyed by its first message: every
 * guardian or agent message placed in a thread other than as its first.
 */
export function threadReplyCounts(messages: readonly ChatMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const thread = message.chatThreadId;
    if (!thread || thread === message.id) continue;
    counts.set(thread, (counts.get(thread) ?? 0) + 1);
  }
  return counts;
}

/** Memoized {@link threadReplyCounts}, as the provider's value. */
export function useChatThreadsValue(messages: readonly ChatMessage[]): ChatThreads {
  return useMemo(() => ({ replies: threadReplyCounts(messages) }), [messages]);
}

function wordsOf(message: ChatMessage): string {
  return parseMessageEntries(message)
    .flatMap((part) => (part.type === "text" && part.content.trim() ? [part.content] : []))
    .join("\n\n");
}

/**
 * The muted "N replies" line under a thread's first message, which opens the
 * thread. Renders nothing for a message that starts no thread with replies,
 * and inside the thread view.
 */
export function ThreadRepliesLine({ message }: { message: ChatMessage }) {
  const { t } = useTranslation("chat");
  const threads = useChatThreads();
  const draft = useReplyDraft();
  const count = threads?.replies.get(message.id) ?? 0;
  if (!threads || !draft?.threads || count === 0 || draft.sessionId !== message.sessionId) {
    return null;
  }
  const guardian = message.role === "user";
  return (
    <button
      type="button"
      data-thread-replies={message.id}
      onClick={() =>
        draft.openThread({
          messageId: message.id,
          author:
            message.sender?.kind === "automated" ? "automated" : guardian ? "guardian" : "agent",
          preview: replyPreview(wordsOf(message)),
        })
      }
      className={cn(
        "rounded-4 px-1 text-aux text-muted-foreground outline-1 outline-offset-0 outline-transparent hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50",
        guardian ? "self-end" : "self-start",
      )}
    >
      {t("thread.replies", { count })}
    </button>
  );
}
