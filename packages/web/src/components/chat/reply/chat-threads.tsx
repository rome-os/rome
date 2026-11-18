// The chat threads of a Concierge chat's main transcript
// (docs/domains/chats.md#chat-thread). A thread is a reply chain, known by its
// root. A quote in a reply focuses the chat on its thread.

import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { SystemInputSource } from "@rome/api-types/trace-segments";
import type { ChatMessage } from "@/lib/chat-types";
import { userMessageText } from "@/components/chat/chat-view";
import { isRenderable } from "@/components/chat/concierge-groups";
import { plainQuote, replyPreview } from "./reply-source";
import type { ReplyTarget } from "./reply-draft";

/**
 * A thread with replies, as the main timeline shows it under its root
 * (ThreadStack.tsx): how many replies it has, how many of them the owner has
 * not seen, and its newest message. The root is not a reply.
 */
export interface ThreadStack {
  root: string;
  total: number;
  /** Replies not said by the owner that the owner has not seen. */
  unread: number;
  /** Where the newest unread reply stands among the timeline's messages, to order the threads that wait. */
  unreadAt: number;
  last: Pick<ChatMessage, "id" | "role" | "content">;
}

export interface ChatThreads {
  /** The root of the thread each message of more than one is in, by message id: the guardian's too. */
  roots: ReadonlyMap<string, string>;
  /** Each thread's name, by its root, when it has one. */
  titles: ReadonlyMap<string, string>;
  /** The root of the thread the transcript is filtered to, or null when it shows every message. */
  focus: string | null;
  /** Every thread that has replies, by its root, but the one in focus. Empty where the timeline shows each message itself. */
  stacks: ReadonlyMap<string, ThreadStack>;
  /** The replies the main timeline leaves out for their thread's stack. Those of the thread in focus are shown. */
  stacked: ReadonlySet<string>;
}

const ChatThreadsContext = createContext<ChatThreads | null>(null);

export const ChatThreadsProvider = ChatThreadsContext.Provider;

/** The chat threads of the transcript this renders in, or null outside a Concierge chat's own. */
export function useChatThreads(): ChatThreads | null {
  return useContext(ChatThreadsContext);
}

/** A message of the timeline, as the thread rules read it. */
export type ThreadTimelineMessage = Pick<ChatMessage, "id" | "role" | "chatThreadId"> &
  Partial<Pick<ChatMessage, "content" | "chatThreadTitle" | "read" | "sender">>;

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

/**
 * The stack of each thread with replies in a loaded timeline, by root, and the
 * replies that stand in a stack. Every reply stands in one, whether its root
 * is loaded or not: a Concierge chat never draws a reply in the main line. A
 * thread whose root is not loaded still has its stack, which only a pill
 * shows, until the reader reads down to the root and the stack draws under
 * it. A thread with a loaded root has all its replies, as the server pages
 * them with it, so its counts are whole.
 */
function stacksOf(
  messages: readonly ThreadTimelineMessage[],
  roots: ReadonlyMap<string, string>,
): { stacks: Map<string, ThreadStack>; stacked: Set<string> } {
  const stacks = new Map<string, ThreadStack>();
  const stacked = new Set<string>();
  messages.forEach((message, at) => {
    const root = roots.get(message.id);
    if (root === undefined || root === message.id) return;
    stacked.add(message.id);
    // What the owner reads: a message the timeline draws, and no automation's.
    if (message.role !== "user" && message.role !== "assistant") return;
    if (message.sender?.kind === "automated") return;
    if (message.content !== undefined && !isRenderable(message as ChatMessage)) return;
    const stack = stacks.get(root);
    const unread = message.role !== "user" && message.read === false;
    stacks.set(root, {
      root,
      total: (stack?.total ?? 0) + 1,
      unread: (stack?.unread ?? 0) + (unread ? 1 : 0),
      unreadAt: unread ? at : (stack?.unreadAt ?? -1),
      last: { id: message.id, role: message.role, content: message.content ?? "[]" },
    });
  });
  return { stacks, stacked };
}

const NO_HINTS: ReadonlyMap<string, string> = new Map();

/**
 * What a loaded timeline shows of its chat threads, with the thread in `focus`.
 * Unless `stacking` is off, as in a share, where a message is shown itself
 * and not as a stack, the main timeline leaves the replies out for stacks. A thread
 * in focus shows its own replies in place of its stack. The other threads'
 * replies stay out: the focus hides their threads anyway, so drawing them
 * would only be work, and a flash while the chat changes. `hints` name the
 * threads whose root is not loaded, by root: the first words of what a reply
 * quotes, when the thread has no task title.
 */
export function chatThreadsOf(
  messages: readonly ThreadTimelineMessage[],
  focus: string | null = null,
  stacking = true,
  hints: ReadonlyMap<string, string> = NO_HINTS,
): ChatThreads {
  const { roots, titles } = threadsOf(messages);
  // A thread whose root is not loaded is named by what the server read of it.
  for (const [root, hint] of hints) if (!titles.has(root)) titles.set(root, hint);
  const { stacks, stacked } = stacking
    ? stacksOf(messages, roots)
    : { stacks: new Map<string, ThreadStack>(), stacked: new Set<string>() };
  if (focus !== null) {
    stacks.delete(focus);
    for (const id of stacked) if (roots.get(id) === focus) stacked.delete(id);
  }
  return { roots, titles, focus, stacks, stacked };
}

/** The ids of the messages in thread `root` that the owner has not seen, the root included. */
export function unreadIn(
  messages: readonly ThreadTimelineMessage[],
  roots: ReadonlyMap<string, string>,
  root: string,
): string[] {
  return messages.flatMap((message) =>
    roots.get(message.id) === root && message.read === false ? [message.id] : [],
  );
}

/**
 * The reply a message sent from a composer focused on thread `root` makes: to
 * the last message of the thread that has text, so a card is passed over. The
 * client names it and the server stores it as given. Null when the loaded
 * thread has none.
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
  stacking = true,
  hints: ReadonlyMap<string, string> = NO_HINTS,
): ChatThreads {
  return useMemo(
    () => chatThreadsOf(messages, focus, stacking, hints),
    [messages, focus, stacking, hints],
  );
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
