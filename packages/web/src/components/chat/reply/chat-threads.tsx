// The label under the agent's messages in a chat thread, in a Concierge chat's
// main transcript (docs/domains/chats.md#chat-thread): it names the thread and
// focuses the chat on it. A thread is a reply chain, known by its root, and
// only one that other messages split up shows labels.

import { CornerDownRight } from "lucide-react";
import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import type { SystemInputSource } from "@rome/api-types/trace-segments";
import type { ChatMessage } from "@/lib/chat-types";
import { useReplyDraft } from "./reply-draft";

/** What the label under one message names: its thread, by the thread's name. */
export interface ThreadLabel {
  /** The root of the thread. */
  thread: string;
  /** The thread's name: its newest task's title, else the start of its root's text. */
  title: string;
}

export interface ChatThreads {
  /** The labels to show, by the id of the agent message each sits under. */
  labels: ReadonlyMap<string, ThreadLabel>;
  /** The root of the thread each message of more than one is in, by message id: the guardian's too. */
  roots: ReadonlyMap<string, string>;
  /** Each thread's name, by its root. */
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

/**
 * The thread each message of a loaded timeline is in, by message id, and each
 * thread's name by its root. The server sends `chatThreadId`, the root's key,
 * only for a message in a thread of more than one, and never again for a root
 * that gains its first reply. So a message is in thread R when its
 * `chatThreadId` is R, or when its own id is R and a loaded message says it
 * is in R: a reply that arrives pulls its root in. A message alone in its
 * thread is in none. The name is the one any message of the thread carries.
 */
export function threadsOf(messages: readonly ThreadTimelineMessage[]): {
  roots: Map<string, string>;
  titles: Map<string, string>;
} {
  const named = new Set<string>();
  const titles = new Map<string, string>();
  for (const message of messages) {
    if (!message.chatThreadId) continue;
    named.add(message.chatThreadId);
    if (message.chatThreadTitle) titles.set(message.chatThreadId, message.chatThreadTitle);
  }
  const roots = new Map<string, string>();
  for (const message of messages) {
    const thread = message.chatThreadId ?? (named.has(message.id) ? message.id : null);
    if (thread) roots.set(message.id, thread);
  }
  return { roots, titles };
}

/**
 * The labels of a loaded timeline, named by the thread's name. Only a thread
 * that other messages split up shows labels: some message outside it sits
 * between its first and its last loaded message. A plain back-and-forth shows
 * none. An agent message in such a thread may carry one: a plain message, a
 * forward and a question or approval card alike. A task card, the one shown
 * when its task starts, needs none: it names its task itself. Of a run of such
 * messages in one thread, with nothing else between them, only the first and
 * the last show it, so a run of one or two shows it on each. Another thread's
 * agent message or a task card ends the run; the owner's messages, like a
 * turn's trace, neither end nor join it.
 */
export function threadLabels(messages: readonly ThreadTimelineMessage[]): Map<string, ThreadLabel> {
  const { roots, titles } = threadsOf(messages);
  const split = splitThreads(messages, roots);
  // Each run of one thread's labelled messages, in order: a run ends where
  // another agent message comes between.
  const runs: { label: ThreadLabel; ids: string[] }[] = [];
  let open = false;
  for (const message of messages) {
    // A turn's trace and the owner's messages end nothing.
    if (message.role !== "assistant") continue;
    const thread = roots.get(message.id);
    const title = thread ? titles.get(thread) : undefined;
    if (!thread || !title || !split.has(thread) || isTaskCard(message)) {
      open = false;
      continue;
    }
    const last = runs.at(-1);
    if (open && last?.label.thread === thread) last.ids.push(message.id);
    else runs.push({ label: { thread, title }, ids: [message.id] });
    open = true;
  }
  const labels = new Map<string, ThreadLabel>();
  for (const { label, ids } of runs) {
    labels.set(ids[0]!, label);
    labels.set(ids.at(-1)!, label);
  }
  return labels;
}

/** The threads that a message outside them sits inside, between their first and last loaded message. */
function splitThreads(
  messages: readonly ThreadTimelineMessage[],
  roots: ReadonlyMap<string, string>,
): Set<string> {
  const split = new Set<string>();
  // Each thread seen so far, and whether a message outside it came since its last.
  const outside = new Map<string, boolean>();
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const thread = roots.get(message.id);
    if (thread && outside.get(thread)) split.add(thread);
    for (const other of outside.keys()) if (other !== thread) outside.set(other, true);
    if (thread) outside.set(thread, false);
  }
  return split;
}

/** Memoized {@link threadLabels}, as the provider's value. */
export function useChatThreadsValue(
  messages: readonly ThreadTimelineMessage[],
  focus: string | null = null,
): ChatThreads {
  return useMemo(() => {
    const { roots, titles } = threadsOf(messages);
    return { labels: threadLabels(messages), roots, titles, focus };
  }, [messages, focus]);
}

/** Whether the message shows a task's card: a task_chat part not shown as its question. */
function isTaskCard(message: ThreadTimelineMessage): boolean {
  if (message.content === undefined) return false;
  return parseMessageEntries({ id: message.id, content: message.content }).some(
    (part) => part.type === "task_chat" && part.show !== "ask",
  );
}

/**
 * The quiet look of a label under a message, as the iOS app draws it: about a
 * spacing step from its bubble, a small turn-down arrow then the text, faint,
 * cut short when long. It does not change on hover.
 */
const LABEL_LINE =
  "-mt-1 mb-1 flex max-w-full min-w-0 items-center gap-1 px-3 text-aux text-muted-foreground/75";

/** The label's arrow: iOS's light 9pt `arrow.turn.down.right`, as a thin lucide icon. */
function LabelArrow() {
  return <CornerDownRight aria-hidden="true" strokeWidth={1.5} className="size-3 shrink-0" />;
}

/**
 * The subdued `<arrow> <thread name>` label under an agent message in a chat
 * thread that other messages split up, which focuses the chat on the thread, and closes the focus while it
 * is on that thread. Renders nothing under the guardian's messages. A message in no thread whose turn the
 * Concierge took on its own, from a routine, an app, another agent or what
 * it follows, shows `source` instead, in the same place and look, as plain
 * text: at most one label per message, and a thread's wins.
 */
export function ThreadLabelLine({
  message,
  source,
}: {
  message: ChatMessage;
  source?: SystemInputSource;
}) {
  const threads = useChatThreads();
  const draft = useReplyDraft();
  const label = threads?.labels.get(message.id);
  if (!label || !draft?.threads || draft.sessionId !== message.sessionId) {
    // A message in a thread shows its thread's label or none.
    if (threads?.roots.has(message.id)) return null;
    return source ? <SourceLabel source={source} /> : null;
  }
  const name = label.title;
  const active = draft.thread === label.thread;
  return (
    <button
      type="button"
      data-thread-label={label.thread}
      aria-pressed={active}
      title={name}
      onClick={() => draft.openThread({ thread: message.id, title: name })}
      // About 4px (a spacing step) from its own bubble and 12px before the next
      // message, so it reads as its bubble's. It keeps its look on hover, and
      // darkens while its thread is in focus; a keyboard focus shows a ring. A
      // long title is cut at a fixed width, whole in the tooltip and the
      // accessible name.
      className={`${LABEL_LINE} cursor-pointer rounded-4 text-left aria-pressed:text-muted-foreground outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50`}
    >
      <LabelArrow />
      <span className="max-w-56 truncate">{name}</span>
    </button>
  );
}

/** Where a message's turn came from, such as "Routine · Daily summary": text with no arrow, not a control. */
function SourceLabel({ source }: { source: SystemInputSource }) {
  const { t } = useTranslation("chat");
  const kind = t(`automatedInput.kinds.${source.type}`);
  const name = source.name ? t("automatedInput.named", { kind, name: source.name }) : kind;
  return (
    <p data-source-label={source.type} title={name} className={LABEL_LINE}>
      <span className="max-w-56 truncate">{name}</span>
    </p>
  );
}
