// The label under each of the agent's messages in a task's chat thread, in a
// Concierge chat's main transcript (docs/domains/chats.md#chat-thread): it
// names the task and opens its thread's view. Only a task has a thread, so a
// thread no task has, from before, shows no label. The thread view's own
// transcript has no provider, so it shows none.

import { createContext, useContext, useMemo } from "react";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { ChatMessage } from "@/lib/chat-types";
import { useReplyDraft } from "./reply-draft";
import { replyPreview } from "./reply-source";

/** What the label under one message names: its task's thread, by the task's title. */
export interface ThreadLabel {
  thread: string;
  /** The title of the task the thread is. */
  title: string;
}

export interface ChatThreads {
  /** The labels to show, by the id of the agent message each sits under. */
  labels: ReadonlyMap<string, ThreadLabel>;
  /** The task thread each message in one is in, by message id: the guardian's too. */
  taskThreads: ReadonlyMap<string, string>;
}

const ChatThreadsContext = createContext<ChatThreads | null>(null);

export const ChatThreadsProvider = ChatThreadsContext.Provider;

/** The chat threads of the transcript this renders in, or null inside the thread view. */
export function useChatThreads(): ChatThreads | null {
  return useContext(ChatThreadsContext);
}

/** A message of the timeline, as the label rule reads it. */
export type ThreadTimelineMessage = Pick<ChatMessage, "id" | "role" | "chatThreadId"> &
  Partial<Pick<ChatMessage, "content" | "chatThreadTitle">>;

/**
 * The task thread each message of a loaded timeline is in. A thread is a
 * task's when the task's title is known, from any of its messages or
 * `liveTitles`; a thread no task has counts as none.
 */
export function taskThreads(
  messages: readonly ThreadTimelineMessage[],
  liveTitles: ReadonlyMap<string, string> = new Map(),
): { threads: Map<string, string>; titles: Map<string, string> } {
  const titles = new Map<string, string>();
  for (const message of messages) {
    if (message.chatThreadId && message.chatThreadTitle) {
      titles.set(message.chatThreadId, message.chatThreadTitle);
    }
  }
  for (const [thread, title] of liveTitles) titles.set(thread, title);
  const threads = new Map<string, string>();
  for (const message of messages) {
    if (message.chatThreadId && titles.has(message.chatThreadId)) {
      threads.set(message.id, message.chatThreadId);
    }
  }
  return { threads, titles };
}

/**
 * The labels of a loaded timeline: one under every agent message in a task's
 * thread, named by the task's title, and none under the guardian's.
 */
export function threadLabels(
  messages: readonly ThreadTimelineMessage[],
  liveTitles: ReadonlyMap<string, string> = new Map(),
): Map<string, ThreadLabel> {
  const { threads, titles } = taskThreads(messages, liveTitles);
  const labels = new Map<string, ThreadLabel>();
  for (const message of messages) {
    const thread = threads.get(message.id);
    const title = thread ? titles.get(thread) : undefined;
    if (message.role !== "assistant" || !thread || !title) continue;
    labels.set(message.id, { thread, title });
  }
  return labels;
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
 * Memoized {@link threadLabels}, as the provider's value, with the live
 * placements and task titles told since the timeline loaded applied over it.
 */
export function useChatThreadsValue(
  messages: readonly ThreadTimelineMessage[],
  rethreaded: ReadonlyMap<string, ThreadPlacement>,
  liveTitles: ReadonlyMap<string, string>,
): ChatThreads {
  return useMemo(() => {
    const shown = placed(messages, rethreaded);
    return {
      labels: threadLabels(shown, liveTitles),
      taskThreads: taskThreads(shown, liveTitles).threads,
    };
  }, [messages, rethreaded, liveTitles]);
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

function wordsOf(message: Pick<ChatMessage, "id" | "content">): string {
  return parseMessageEntries(message)
    .flatMap((part) => (part.type === "text" && part.content.trim() ? [part.content] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The subdued `↳ <task title>` label under an agent message in a task's chat
 * thread, which opens the thread. Renders nothing under the guardian's
 * messages and inside the thread view.
 */
export function ThreadLabelLine({ message }: { message: ChatMessage }) {
  const threads = useChatThreads();
  const draft = useReplyDraft();
  const label = threads?.labels.get(message.id);
  if (!label || !draft?.threads || draft.sessionId !== message.sessionId) return null;
  const name = label.title;
  return (
    <button
      type="button"
      data-thread-label={label.thread}
      title={name}
      onClick={() =>
        draft.openThread({
          messageId: message.id,
          author: "agent",
          preview: replyPreview(wordsOf(message)),
        })
      }
      className="-mt-2 max-w-full truncate rounded-4 px-1 text-left text-aux text-muted-foreground/60 outline-1 outline-offset-0 outline-transparent transition-colors hover:text-muted-foreground focus-visible:outline-solid focus-visible:outline-ring/50 motion-reduce:transition-none"
    >
      <span aria-hidden="true">↳ </span>
      {name}
    </button>
  );
}
