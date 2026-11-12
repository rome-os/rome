// The label under each of the agent's messages in a chat thread, in a
// Concierge chat's main transcript (docs/domains/chats.md#chat-thread): it
// names the thread and opens its view. The thread view's own transcript has
// no provider, so it shows none.

import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { ChatMessage } from "@/lib/chat-types";
import { useReplyDraft } from "./reply-draft";
import { replyPreview } from "./reply-source";

/** What the label under one message names: its thread, by the task's title or the root's words. */
export interface ThreadLabel {
  thread: string;
  /** The title of the task the thread is, or null for a thread no task has. */
  title: string | null;
  /** The start of the thread's first message, when it is loaded. */
  rootPreview: string | null;
}

export interface ChatThreads {
  /** The labels to show, by the id of the agent message each sits under. */
  labels: ReadonlyMap<string, ThreadLabel>;
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
 * The labels of a loaded timeline: one under every agent message in a chat
 * thread, and none under the guardian's. A thread is named by its task's
 * title, from any of its messages or `liveTitles`, else by its root's words.
 */
export function threadLabels(
  messages: readonly ThreadTimelineMessage[],
  liveTitles: ReadonlyMap<string, string> = new Map(),
): Map<string, ThreadLabel> {
  const titles = new Map<string, string>();
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of messages) {
    if (message.chatThreadId && message.chatThreadTitle) {
      titles.set(message.chatThreadId, message.chatThreadTitle);
    }
  }
  for (const [thread, title] of liveTitles) titles.set(thread, title);
  const labels = new Map<string, ThreadLabel>();
  for (const message of messages) {
    const thread = message.chatThreadId;
    if (message.role !== "assistant" || !thread) continue;
    const root = byId.get(thread);
    const words = root?.content ? wordsOf({ id: root.id, content: root.content }) : "";
    labels.set(message.id, {
      thread,
      title: titles.get(thread) ?? null,
      rootPreview: words ? replyPreview(words) : null,
    });
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
  return useMemo(
    () => ({ labels: threadLabels(placed(messages, rethreaded), liveTitles) }),
    [messages, rethreaded, liveTitles],
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

function wordsOf(message: Pick<ChatMessage, "id" | "content">): string {
  return parseMessageEntries(message)
    .flatMap((part) => (part.type === "text" && part.content.trim() ? [part.content] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The subdued `↳ <name>` label under an agent message in a chat thread, which
 * opens the thread. The name is the task's title, else the start of the
 * thread's first message. Renders nothing under the guardian's messages and
 * inside the thread view.
 */
export function ThreadLabelLine({ message }: { message: ChatMessage }) {
  const { t } = useTranslation("chat");
  const threads = useChatThreads();
  const draft = useReplyDraft();
  const label = threads?.labels.get(message.id);
  if (!label || !draft?.threads || draft.sessionId !== message.sessionId) return null;
  const name = label.title ?? t("thread.replyTo", { preview: label.rootPreview ?? "…" });
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
