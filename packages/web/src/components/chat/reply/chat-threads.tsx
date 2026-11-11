// The "N replies" line of a Concierge chat's main transcript
// (docs/domains/chats.md#chat-thread), which opens a thread's view. It
// follows the iOS app's rule, so it shows only where the timeline alone does
// not show the whole thread. The thread view's own transcript has no
// provider, so it shows no line.

import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { ChatMessage } from "@/lib/chat-types";
import { useReplyDraft } from "./reply-draft";
import { replyPreview } from "./reply-source";

export interface ChatThreads {
  /** The lines to show: by the id of the agent message each sits under, how many replies it counts. */
  lines: ReadonlyMap<string, number>;
}

const ChatThreadsContext = createContext<ChatThreads | null>(null);

export const ChatThreadsProvider = ChatThreadsContext.Provider;

/** The chat threads of the transcript this renders in, or null inside the thread view. */
export function useChatThreads(): ChatThreads | null {
  return useContext(ChatThreadsContext);
}

/** A message of the timeline, as the replies rule reads it. */
export type ThreadTimelineMessage = Pick<ChatMessage, "id" | "role" | "chatThreadId">;

/**
 * Where the "N replies" lines go in a loaded timeline, oldest message first:
 * by the id of the message each sits under, the count it shows. A thread's
 * count is its loaded messages less its root, the message that names it.
 * A thread with replies shows a line under its root, and one under its
 * newest message when a message of another thread, or of none, lies between
 * the two. A thread whose root is not loaded shows one under its newest
 * message only. A line moves to the newest message as one arrives.
 */
export function threadRepliesLines(
  messages: readonly ThreadTimelineMessage[],
): Map<string, number> {
  const timeline = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const at = new Map(timeline.map((message, index) => [message.id, index]));
  const replies = new Map<string, number[]>();
  timeline.forEach((message, index) => {
    const thread = message.chatThreadId;
    if (!thread || message.id === thread) return;
    replies.set(thread, [...(replies.get(thread) ?? []), index]);
  });
  const lines = new Map<string, number>();
  for (const [thread, indexes] of replies) {
    const newest = indexes[indexes.length - 1] as number;
    const newestId = timeline[newest]?.id as string;
    const root = at.get(thread);
    if (root === undefined) {
      lines.set(newestId, indexes.length);
      continue;
    }
    lines.set(thread, indexes.length);
    const apart = timeline
      .slice(root + 1, newest)
      .some((message) => message.chatThreadId !== thread);
    if (apart) lines.set(newestId, indexes.length);
  }
  return lines;
}

/**
 * A live placement of a message in a chat thread: `to`, made while the loaded
 * message was in `from`. It holds only while the loaded message still is, so
 * an authoritative reload that says otherwise retires it.
 */
export interface ThreadPlacement {
  from: string | null;
  to: string;
}

/**
 * Memoized {@link threadRepliesLines}, as the provider's value, with the
 * live placements made since the timeline loaded applied over it.
 */
export function useChatThreadsValue(
  messages: readonly ThreadTimelineMessage[],
  rethreaded: ReadonlyMap<string, ThreadPlacement>,
): ChatThreads {
  return useMemo(
    () => ({ lines: threadRepliesLines(placed(messages, rethreaded)) }),
    [messages, rethreaded],
  );
}

/**
 * `rethreaded` with a live placement of `messageId` in `to`, made over
 * `loaded`, the thread the currently loaded message has. A placement held
 * from before a reload rebases on what the reload said, so the next one still
 * applies.
 */
export function placeLive(
  rethreaded: ReadonlyMap<string, ThreadPlacement>,
  messageId: string,
  to: string,
  loaded: string | null,
): ReadonlyMap<string, ThreadPlacement> {
  const held = rethreaded.get(messageId);
  if (held?.from === loaded && held.to === to) return rethreaded;
  const next = new Map(rethreaded);
  next.set(messageId, { from: loaded, to });
  return next;
}

/** `messages` with each live placement that still holds applied. */
export function placed(
  messages: readonly ThreadTimelineMessage[],
  rethreaded: ReadonlyMap<string, ThreadPlacement>,
): ThreadTimelineMessage[] {
  if (rethreaded.size === 0) return [...messages];
  return messages.map((message) => {
    const placement = rethreaded.get(message.id);
    return placement && (message.chatThreadId ?? null) === placement.from
      ? { ...message, chatThreadId: placement.to }
      : message;
  });
}

function wordsOf(message: ChatMessage): string {
  return parseMessageEntries(message)
    .flatMap((part) => (part.type === "text" && part.content.trim() ? [part.content] : []))
    .join("\n\n");
}

/**
 * The subdued "N replies" line under a chat thread's root or newest message,
 * which opens the thread. Renders nothing where {@link threadRepliesLines}
 * puts no line, and inside the thread view.
 */
export function ThreadRepliesLine({ message }: { message: ChatMessage }) {
  const { t } = useTranslation("chat");
  const threads = useChatThreads();
  const draft = useReplyDraft();
  const count = threads?.lines.get(message.id) ?? 0;
  if (!threads || !draft?.threads || count === 0 || draft.sessionId !== message.sessionId) {
    return null;
  }
  return (
    <button
      type="button"
      data-thread-replies={message.id}
      onClick={() =>
        draft.openThread({
          messageId: message.id,
          author: message.role === "user" ? "guardian" : "agent",
          preview: replyPreview(wordsOf(message)),
        })
      }
      className="rounded-4 px-1 text-aux text-muted-foreground outline-1 outline-offset-0 outline-transparent hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50"
    >
      {t("thread.replies", { count })}
    </button>
  );
}
