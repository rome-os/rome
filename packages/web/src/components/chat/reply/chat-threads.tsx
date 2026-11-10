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

interface Run {
  thread: string | null;
  messages: ThreadTimelineMessage[];
}

/**
 * Where the "N replies" lines go in a loaded timeline, oldest message first:
 * by the id of the agent message each sits under, the number of replies.
 *
 * A run is a stretch of guardian and agent messages in one chat thread, with
 * no message of another between them. A run gets a line under its last agent
 * message when the timeline alone does not show its thread whole: the thread
 * has messages outside the run, its first message is not in the run, or it
 * has 4 or more messages. A question and its answer alone get none. Of two
 * neighbouring runs that both qualify, only the later keeps its line. The
 * count is the thread's loaded messages less one; a thread whose count would
 * be 0 gets none.
 */
export function threadRepliesLines(
  messages: readonly ThreadTimelineMessage[],
): Map<string, number> {
  const timeline = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const totals = new Map<string, number>();
  for (const message of timeline) {
    if (message.chatThreadId) {
      totals.set(message.chatThreadId, (totals.get(message.chatThreadId) ?? 0) + 1);
    }
  }
  const runs: Run[] = [];
  for (const message of timeline) {
    const thread = message.chatThreadId ?? null;
    const last = runs.at(-1);
    if (last && last.thread === thread) last.messages.push(message);
    else runs.push({ thread, messages: [message] });
  }
  const qualifies = runs.map((run): { under: string; count: number } | null => {
    if (!run.thread) return null;
    const under = run.messages.findLast((message) => message.role === "assistant");
    if (!under) return null;
    const total = totals.get(run.thread) ?? 0;
    const outside = total > run.messages.length;
    const rootMissing = !run.messages.some((message) => message.id === run.thread);
    if (!outside && !rootMissing && total < 4) return null;
    return total - 1 > 0 ? { under: under.id, count: total - 1 } : null;
  });
  const lines = new Map<string, number>();
  let laterKept = false;
  for (let index = runs.length - 1; index >= 0; index--) {
    const line = qualifies[index];
    const kept: boolean = line !== null && !laterKept;
    if (kept && line) lines.set(line.under, line.count);
    laterKept = kept;
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
 * The subdued "N replies" line under an agent message, which opens the
 * message's chat thread. Renders nothing where {@link threadRepliesLines}
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
          author: "agent",
          preview: replyPreview(wordsOf(message)),
        })
      }
      className="self-start rounded-4 px-1 text-aux text-muted-foreground outline-1 outline-offset-0 outline-transparent hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50"
    >
      {t("thread.replies", { count })}
    </button>
  );
}
