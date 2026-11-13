// The label under each of the agent's messages in a task's chat thread, in a
// Concierge chat's main transcript (docs/domains/chats.md#chat-thread): it
// names the task and opens its thread's view. Only a task has a thread, so a
// thread no task has, from before, shows no label. The thread view's own
// transcript has no provider, so it shows none.

import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SystemInputSource } from "@rome/api-types/trace-segments";
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
  liveTitles: ReadonlyMap<string, string | null> = new Map(),
): { threads: Map<string, string>; titles: Map<string, string> } {
  const titles = new Map<string, string>();
  for (const message of messages) {
    if (message.chatThreadId && message.chatThreadTitle) {
      titles.set(message.chatThreadId, message.chatThreadTitle);
    }
  }
  // A live title wins; null is a thread whose task left the chat.
  for (const [thread, title] of liveTitles) {
    if (title === null) titles.delete(thread);
    else titles.set(thread, title);
  }
  const threads = new Map<string, string>();
  for (const message of messages) {
    if (message.chatThreadId && titles.has(message.chatThreadId)) {
      threads.set(message.id, message.chatThreadId);
    }
  }
  return { threads, titles };
}

/**
 * The labels of a loaded timeline, named by the task's title. An agent
 * message in a task's thread may carry one: a plain message, a forward and a
 * question or approval card alike. A task card, the one shown when its task
 * starts, needs none: it names its task itself. Of a run of such messages in
 * one thread, with nothing else between them, only the first and the last
 * show it, so a run of one or two shows it on each. Any other message, the
 * owner's included, ends the run.
 */
export function threadLabels(
  messages: readonly ThreadTimelineMessage[],
  liveTitles: ReadonlyMap<string, string | null> = new Map(),
): Map<string, ThreadLabel> {
  const { threads, titles } = taskThreads(messages, liveTitles);
  // Each run of one thread's labelled messages, in order: a run ends where
  // any other message comes between.
  const runs: { label: ThreadLabel; ids: string[] }[] = [];
  let open = false;
  for (const message of messages) {
    // A turn's trace is no message of the timeline: it ends nothing.
    if (message.role !== "assistant" && message.role !== "user") continue;
    const thread = threads.get(message.id);
    const title = thread ? titles.get(thread) : undefined;
    if (message.role !== "assistant" || !thread || !title || isTaskCard(message)) {
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
  liveTitles: ReadonlyMap<string, string | null>,
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

/** Whether the message shows a task's card: a task_chat part not shown as its question. */
function isTaskCard(message: ThreadTimelineMessage): boolean {
  if (message.content === undefined) return false;
  return parseMessageEntries({ id: message.id, content: message.content }).some(
    (part) => part.type === "task_chat" && part.show !== "ask",
  );
}

function wordsOf(message: Pick<ChatMessage, "id" | "content">): string {
  return parseMessageEntries(message)
    .flatMap((part) => (part.type === "text" && part.content.trim() ? [part.content] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The quiet look of a label under a message: about a spacing step from its bubble, faint, cut short when long. */
const LABEL_LINE = "-mt-1 mb-1 flex max-w-full min-w-0 px-1 text-aux text-subtle-foreground/70";

/**
 * The subdued `↳ <task title>` label under an agent message in a task's chat
 * thread, which opens the thread. Renders nothing under the guardian's
 * messages and inside the thread view. A message in no thread whose turn the
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
    // A message in a task's thread shows its thread's label or none.
    if (threads?.taskThreads.has(message.id)) return null;
    return source ? <SourceLabel source={source} /> : null;
  }
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
      // About 4px (a spacing step) from its own bubble and 12px before the next message, so it
      // reads as its bubble's. Regular weight and faint until hovered or
      // focused; a long title is cut at a fixed width, whole in the tooltip
      // and the accessible name.
      className={`${LABEL_LINE} rounded-4 text-left outline-1 outline-offset-0 outline-transparent transition-colors hover:text-muted-foreground focus-visible:text-muted-foreground focus-visible:outline-solid focus-visible:outline-ring/50 motion-reduce:transition-none`}
    >
      <span aria-hidden="true" className="shrink-0">
        ↳&nbsp;
      </span>
      <span className="max-w-56 truncate">{name}</span>
    </button>
  );
}

/** Where a message's turn came from, such as "Routine · Daily summary": text, not a control. */
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
