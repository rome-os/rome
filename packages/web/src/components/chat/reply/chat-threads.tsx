// The chat threads of a Concierge chat's main transcript
// (docs/domains/chats.md#chat-thread). A thread is a reply chain, known by its
// root. A quote in a reply focuses the chat on its thread.

import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { SystemInputSource } from "@rome/api-types/trace-segments";
import type { ChatMessage } from "@/lib/chat-types";
import { userMessageText } from "@/components/chat/chat-view";
import { plainQuote, replyPreview } from "./reply-source";
import type { ReplyTarget } from "./reply-draft";

export interface ChatThreads {
  /** The root of the thread each message of more than one is in, by message id: the guardian's too. */
  roots: ReadonlyMap<string, string>;
  /** Each thread's name, by its root, when it has one. */
  titles: ReadonlyMap<string, string>;
  /** The root of the thread the transcript is filtered to, or null when it shows every message. */
  focus: string | null;
}

const ChatThreadsContext = createContext<ChatThreads | null>(null);

export const ChatThreadsProvider = ChatThreadsContext.Provider;

/** The chat threads of the transcript this renders in, or null outside a Concierge chat's own. */
export function useChatThreads(): ChatThreads | null {
  return useContext(ChatThreadsContext);
}

/** A message of the timeline, as the thread rules read it. */
export type ThreadTimelineMessage = Pick<ChatMessage, "id" | "role" | "chatThreadId"> &
  Partial<Pick<ChatMessage, "content" | "chatThreadTitle">>;

/** How much of a root's text names its thread. */
const THREAD_NAME_MAX = 50;

/** The first line of a message's text, cut short, or null when it has none. */
function startOfText(message: ThreadTimelineMessage): string | null {
  if (message.content === undefined) return null;
  const part = parseMessageEntries({ id: message.id, content: message.content }).find(
    (candidate) => candidate.type === "text",
  );
  const line = plainQuote(part?.type === "text" ? (part.content.split("\n", 1)[0] ?? "") : "");
  if (!line) return null;
  const letters = Array.from(line);
  return letters.length > THREAD_NAME_MAX
    ? `${letters.slice(0, THREAD_NAME_MAX - 1).join("")}…`
    : line;
}

/**
 * The thread each message of a loaded timeline is in, by message id, and each
 * thread's name by its root. The server sends `chatThreadId`, the root's key,
 * for every message of a Concierge chat. A message is in a thread of more than
 * one when its root is another message, or when a loaded message says it is
 * the root. A message alone in its thread is in none. The name is the title of
 * the newest task whose start message is in the thread, which any of its
 * messages carries, else the start of the root's text when the root is loaded.
 */
export function threadsOf(messages: readonly ThreadTimelineMessage[]): {
  roots: Map<string, string>;
  titles: Map<string, string>;
} {
  const named = new Set<string>();
  const titles = new Map<string, string>();
  for (const message of messages) {
    if (!message.chatThreadId) continue;
    if (message.chatThreadId !== message.id) named.add(message.chatThreadId);
    if (message.chatThreadTitle) titles.set(message.chatThreadId, message.chatThreadTitle);
  }
  const roots = new Map<string, string>();
  for (const message of messages) {
    const thread = message.chatThreadId ?? message.id;
    if (thread !== message.id || named.has(message.id)) roots.set(message.id, thread);
    if (thread === message.id && named.has(thread) && !titles.has(thread)) {
      const name = startOfText(message);
      if (name) titles.set(thread, name);
    }
  }
  return { roots, titles };
}

/** What a loaded timeline shows of its chat threads, with the thread in `focus`. */
export function chatThreadsOf(
  messages: readonly ThreadTimelineMessage[],
  focus: string | null = null,
): ChatThreads {
  const { roots, titles } = threadsOf(messages);
  return { roots, titles, focus };
}

/**
 * The reply a message sent from a composer focused on thread `root` makes: to
 * the last message of the thread that has text, as the server resolves it. Null
 * when the loaded thread has none.
 */
export function threadTail(
  messages: readonly ChatMessage[],
  roots: ReadonlyMap<string, string>,
  root: string,
): ReplyTarget | null {
  for (const message of messages.toReversed()) {
    if (roots.get(message.id) !== root) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text =
      message.role === "user"
        ? userMessageText(message.content)
        : parseMessageEntries(message)
            .flatMap((part) => (part.type === "text" && part.content.trim() ? [part.content] : []))
            .join("\n\n");
    if (!text.trim()) continue;
    const automated = message.sender?.kind === "automated";
    return {
      messageId: message.id,
      author: message.role === "assistant" ? "agent" : automated ? "automated" : "guardian",
      ...(automated && message.sender?.name ? { name: message.sender.name } : {}),
      preview: replyPreview(text),
    };
  }
  return null;
}

/** Memoized {@link chatThreadsOf}, as the provider's value. */
export function useChatThreadsValue(
  messages: readonly ThreadTimelineMessage[],
  focus: string | null = null,
): ChatThreads {
  return useMemo(() => chatThreadsOf(messages, focus), [messages, focus]);
}

/**
 * The quiet look of the line under a message that says where its turn came
 * from, as the iOS app draws it: about a spacing step from its bubble, faint,
 * cut short when long.
 */
const SOURCE_LINE =
  "-mt-1 mb-1 flex max-w-full min-w-0 items-center gap-1 px-3 text-aux text-muted-foreground/75";

/**
 * Where a message's turn came from, such as "Routine · Daily summary", under a
 * message the Concierge said on its own, from a routine, an app, another agent
 * or what it follows: text, not a control.
 */
export function SourceLabel({ source }: { source: SystemInputSource }) {
  const { t } = useTranslation("chat");
  const kind = t(`automatedInput.kinds.${source.type}`);
  const name = source.name ? t("automatedInput.named", { kind, name: source.name }) : kind;
  return (
    <p data-source-label={source.type} title={name} className={SOURCE_LINE}>
      <span className="max-w-56 truncate">{name}</span>
    </p>
  );
}
