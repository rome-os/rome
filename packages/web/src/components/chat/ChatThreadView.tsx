import { MessageSquare, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { IconButton } from "@/components/ui/icon-button";
import { useQuery } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { chatSessionTopic, useLiveEvents } from "@/hooks/use-live-events";
import { listChatThreadMessages } from "@/lib/chat-api";
import type { ChatMessage } from "@/lib/chat-types";
import { LANDING_MS, messageBubbles, playLanding } from "./reply/thread-anchor";

/** The query key of one chat thread, named by any of its messages. */
export function chatThreadQueryKey(sessionId: string, messageId: string) {
  return ["chat-thread", sessionId, messageId] as const;
}

const anyEvent = z.unknown();

/**
 * One chat thread of a Concierge chat on its own (docs/domains/chats.md#chat-thread),
 * the body of the tool pane's Chat thread tab: a header with the task's title
 * and `actions`, the thread's messages, drawn by `renderMessages`, at the
 * bottom of a list that scrolls when long, and the thread's `composer`. New
 * messages in the thread appear as they are said. The chat stays beside it.
 *
 * Esc inside it closes it, unless what has focus used the key first.
 */
export function ChatThreadView({
  sessionId,
  messageId,
  title,
  onClose,
  actions,
  renderMessages,
  composer,
}: {
  sessionId: string;
  /** Any message of the thread. */
  messageId: string;
  /** The task's title; empty when none is known. */
  title: string;
  onClose: () => void;
  /** Header buttons before the close button. */
  actions?: ReactNode;
  renderMessages: (messages: ChatMessage[]) => ReactNode;
  composer?: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const thread = useQuery({
    queryKey: chatThreadQueryKey(sessionId, messageId),
    queryFn: async () => (await listChatThreadMessages(sessionId, messageId)) ?? [],
  });
  const refetch = thread.refetch;
  // Any message said or placed in the chat may be this thread's.
  useLiveEvents(chatSessionTopic(sessionId), {
    message_insert: { schema: anyEvent, fn: () => void refetch() },
    message_chat_thread: { schema: anyEvent, fn: () => void refetch() },
  });

  const messages = (thread.data ?? []).filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const count = messages.length;
  // The newest message stays at the bottom, in view, while the thread is read
  // there: when a message arrives, and when the list or its content changes
  // size, as the composer grows with the draft.
  const following = useRef(true);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && following.current) list.scrollTop = list.scrollHeight;
  }, [count]);
  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const list = listRef.current;
    if (list) following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
  };

  // The thread's copy of the message it opened from gets the same brief tint
  // a jump gives, so the eye finds it.
  const shown = count > 0;
  useEffect(() => {
    const list = listRef.current;
    if (!list || !shown) return;
    const copies = messageBubbles(list, messageId);
    for (const copy of copies) playLanding(copy);
    const end = window.setTimeout(() => {
      for (const copy of copies) copy.removeAttribute("data-timeline-landed");
    }, LANDING_MS);
    return () => {
      window.clearTimeout(end);
      for (const copy of copies) copy.removeAttribute("data-timeline-landed");
    };
  }, [shown, messageId]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    onClose();
  };

  return (
    <section
      aria-label={t("thread.title")}
      data-chat-thread-view
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
        <span
          className="min-w-0 flex-1 truncate text-ui text-foreground"
          title={title || undefined}
        >
          {title || t("thread.title")}
        </span>
        {actions}
        <IconButton size="sm" label={t("thread.close")} icon={<X />} onClick={onClose} />
      </div>
      <div
        ref={listRef}
        onScroll={onScroll}
        className="scrollbar-idle-hidden relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
      >
        {/* `isolate` keeps a blend mode in a message (an avatar's ring) inside
            the list. */}
        <div ref={contentRef} className="mt-auto pt-3">
          {renderMessages(messages)}
          {thread.isError ? (
            <p className="px-3 text-center text-ui text-muted-foreground md:px-6">
              {t("thread.loadFailed")}
            </p>
          ) : null}
        </div>
      </div>
      {composer ? (
        <div className="shrink-0 px-3 pb-[calc(var(--rome-safe-area-bottom)+0.75rem)] pt-2">
          {composer}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The task chat of thread `threadRoot`, from the thread's own messages: the
 * task chat Rome names on them, else the chat a task card or question card in
 * it names (a server before the name), or null when none loaded does.
 */
export function taskChatOfThread(
  messages: readonly ChatMessage[],
  threadRoot: string,
): string | null {
  for (const message of messages) {
    if (message.chatThreadId === threadRoot && message.chatThreadTaskChatId) {
      return message.chatThreadTaskChatId;
    }
  }
  for (const message of messages) {
    if (message.id !== threadRoot && message.chatThreadId !== threadRoot) continue;
    if (message.role !== "assistant") continue;
    for (const part of parseMessageEntries(message)) {
      if (part.type === "task_chat") return part.chatId;
    }
  }
  return null;
}

/**
 * The thread view header's way into the open thread's task chat, when the
 * thread's messages name one: those the thread view loaded, and the chat's own.
 */
export function OpenThreadTaskChat({
  sessionId,
  messageId,
  threadRoot,
  messages,
  liveTaskChat,
  size,
  className,
}: {
  sessionId: string;
  /** The message the thread view opened on, which keys its read of the thread. */
  messageId: string;
  threadRoot: string;
  /** The chat's loaded messages. */
  messages: readonly ChatMessage[];
  /** The thread's task chat a live placement told, if one did. */
  liveTaskChat?: string | null;
  size: "sm" | "md";
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  // The thread view's own read of the thread, shared through the cache.
  const { data: thread } = useQuery({
    queryKey: chatThreadQueryKey(sessionId, messageId),
    queryFn: async () => (await listChatThreadMessages(sessionId, messageId)) ?? [],
    enabled: false,
  });
  const chatId = useMemo(
    () =>
      liveTaskChat ??
      taskChatOfThread(thread ?? [], threadRoot) ??
      taskChatOfThread(messages, threadRoot),
    [liveTaskChat, thread, messages, threadRoot],
  );
  if (!chatId) return null;
  return (
    <IconButton
      size={size}
      label={t("thread.openTaskChat")}
      icon={<MessageSquare />}
      onClick={() => navigate(`/chat/${chatId}`)}
      className={className}
    />
  );
}
