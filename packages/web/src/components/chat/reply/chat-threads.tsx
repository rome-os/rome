// The chat threads of a Concierge chat's main transcript
// (docs/domains/chats.md#chat-thread). A thread is a reply chain, known by its
// root. A quote in a reply focuses the chat on its thread.

import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { SystemInputSource } from "@rome/api-types/trace-segments";
import type { ChatMessage, ThreadSummary } from "@/lib/chat-types";
import { userMessageText } from "@/components/chat/chat-view";
import { plainQuote, replyPreview } from "./reply-source";
import type { ReplyTarget } from "./reply-draft";

/**
 * A thread with replies, as the main timeline shows it under its root
 * (ThreadStack.tsx): how many replies it has, how many of them the owner has
 * not seen, and its newest message. The root is not a reply. It is read from
 * the thread's summary, not counted from the replies that are loaded.
 */
export interface ThreadStack {
  root: string;
  total: number;
  /** Replies not said by the owner that the owner has not seen. */
  unread: number;
  /** When the newest unread reply was said, in ms, to order the threads that wait. */
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

/** Whether a message is a reply the stack counts: said by the owner or the agent, and no automation. */
function countsAsReply(message: ThreadTimelineMessage): boolean {
  return (
    (message.role === "user" || message.role === "assistant") &&
    message.sender?.kind !== "automated"
  );
}

/** Whether the owner has not seen a counted reply: the agent said it and it is not read. */
function isUnreadReply(message: ThreadTimelineMessage): boolean {
  return message.role === "assistant" && message.read === false;
}

/**
 * The summary of a thread from all its replies, which only a thread read
 * whole has. Null when none counts.
 */
function summarizeReplies(replies: readonly ChatMessage[]): ThreadSummary | null {
  const counted = replies.filter(countsAsReply);
  const latest = counted.at(-1);
  if (!latest) return null;
  const unread = counted.filter(isUnreadReply);
  const newestUnread = unread.at(-1);
  return {
    replyCount: counted.length,
    unreadCount: unread.length,
    latestReply: latest,
    unreadAt: newestUnread ? Date.parse(newestUnread.createdAt) || 0 : 0,
  };
}

/**
 * The summary of every thread of `messages` that has replies among them, by
 * root: right for threads read whole, whose replies are all loaded.
 */
export function summariesOfLoaded(messages: readonly ChatMessage[]): Map<string, ThreadSummary> {
  const replies = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const root = message.chatThreadId;
    if (root && root !== message.id) replies.set(root, [...(replies.get(root) ?? []), message]);
  }
  const summaries = new Map<string, ThreadSummary>();
  for (const [root, own] of replies) {
    const summary = summarizeReplies(own);
    if (summary) summaries.set(root, summary);
  }
  return summaries;
}

/**
 * The summaries after a reply came live: it counts once, and is the newest.
 * A reply the summary already holds, or that does not count, changes nothing.
 */
export function withLiveReply(
  summaries: ReadonlyMap<string, ThreadSummary>,
  message: ChatMessage,
): ReadonlyMap<string, ThreadSummary> {
  const root = message.chatThreadId;
  if (!root || root === message.id || !countsAsReply(message)) return summaries;
  const current = summaries.get(root);
  if (current?.latestReply.id === message.id) return summaries;
  const unread = isUnreadReply(message);
  return new Map(summaries).set(root, {
    replyCount: (current?.replyCount ?? 0) + 1,
    unreadCount: (current?.unreadCount ?? 0) + (unread ? 1 : 0),
    latestReply: message,
    unreadAt: unread ? Date.parse(message.createdAt) || 0 : (current?.unreadAt ?? 0),
  });
}

/** The summaries after the owner has seen every reply of the threads `roots`. */
export function withThreadsRead(
  summaries: ReadonlyMap<string, ThreadSummary>,
  roots: Iterable<string>,
): ReadonlyMap<string, ThreadSummary> {
  let next: Map<string, ThreadSummary> | null = null;
  for (const root of roots) {
    const current = (next ?? summaries).get(root);
    if (!current || current.unreadCount === 0) continue;
    next ??= new Map(summaries);
    next.set(root, { ...current, unreadCount: 0, unreadAt: 0 });
  }
  return next ?? summaries;
}

/**
 * The stack of each thread with replies, by root, from the threads' summaries,
 * and the replies that stand in a stack. Every loaded reply stands in one,
 * whether its root is loaded or not: a Concierge chat never draws a reply in
 * the main line. A thread whose root is not loaded still has its stack, which
 * only a pill shows, until the reader reads down to the root and the stack
 * draws under it.
 */
function stacksOf(
  messages: readonly ThreadTimelineMessage[],
  roots: ReadonlyMap<string, string>,
  summaries: ReadonlyMap<string, ThreadSummary>,
): { stacks: Map<string, ThreadStack>; stacked: Set<string> } {
  const stacks = new Map<string, ThreadStack>();
  const stacked = new Set<string>();
  for (const message of messages) {
    const root = roots.get(message.id);
    if (root !== undefined && root !== message.id) stacked.add(message.id);
  }
  for (const [root, summary] of summaries) {
    if (summary.replyCount === 0) continue;
    const { latestReply } = summary;
    stacks.set(root, {
      root,
      total: summary.replyCount,
      unread: summary.unreadCount,
      unreadAt: summary.unreadAt,
      last: { id: latestReply.id, role: latestReply.role, content: latestReply.content ?? "[]" },
    });
  }
  return { stacks, stacked };
}

/** What a timeline knows of its threads besides its messages. */
interface ThreadKnowledge {
  /** The names of threads whose root is not loaded, by root. */
  hints?: ReadonlyMap<string, string>;
  /** The summary of each thread with replies, by root. */
  summaries?: ReadonlyMap<string, ThreadSummary>;
}

const NO_THREAD_KNOWLEDGE: ThreadKnowledge = {};

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
  { hints, summaries }: ThreadKnowledge = NO_THREAD_KNOWLEDGE,
): ChatThreads {
  const { roots, titles } = threadsOf(messages);
  // A thread whose root is not loaded is named by what the server read of it.
  for (const [root, hint] of hints ?? []) if (!titles.has(root)) titles.set(root, hint);
  const { stacks, stacked } = stacking
    ? stacksOf(messages, roots, summaries ?? new Map())
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
  knowledge: ThreadKnowledge = NO_THREAD_KNOWLEDGE,
): ChatThreads {
  return useMemo(
    () => chatThreadsOf(messages, focus, stacking, knowledge),
    [messages, focus, stacking, knowledge],
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
