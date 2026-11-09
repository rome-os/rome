import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import ChatMarkdown from "@/components/chat/ChatMarkdown";
import { IconButton } from "@/components/ui/icon-button";
import { chatSessionTopic, useLiveEvents } from "@/hooks/use-live-events";
import { listChatThreadMessages } from "@/lib/chat-api";
import type { ChatMessage } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

/**
 * Clicks inside an element with this attribute, such as the composer, keep
 * the thread view open. So do clicks in a floating layer portaled outside
 * the app's tree, such as a menu, picker or dialog the composer opened.
 */
export const KEEPS_CHAT_THREAD_OPEN = "data-keeps-chat-thread-open";

/** The query key of one chat thread, named by any of its messages. */
export function chatThreadQueryKey(sessionId: string, messageId: string) {
  return ["chat-thread", sessionId, messageId] as const;
}

const anyEvent = z.unknown();

/**
 * The app's own tree that `element` is rendered in: its topmost ancestor
 * below the body. A floating layer portaled to the body is outside it.
 */
function appTreeOf(element: Element): Element {
  let tree = element;
  while (tree.parentElement && tree.parentElement !== tree.ownerDocument.body) {
    tree = tree.parentElement;
  }
  return tree;
}

/** A message's words as the thread view shows them: its text, and a card's title. */
function wordsOf(message: ChatMessage): string {
  let parts: unknown;
  try {
    parts = JSON.parse(message.content);
  } catch {
    return message.content;
  }
  if (!Array.isArray(parts)) return "";
  return parts
    .flatMap((part: { type?: string; content?: unknown; title?: unknown; label?: unknown }) => {
      if (part.type === "text" && typeof part.content === "string") return [part.content];
      if (part.type === "task_chat" && typeof part.title === "string") return [part.title];
      if (part.type === "connect_card" && typeof part.label === "string") return [part.label];
      return [];
    })
    .join("\n\n");
}

/**
 * One chat thread of a Concierge chat on its own (docs/domains/chats.md#chat-thread),
 * as a light panel over the chat. New messages in the thread appear as they
 * are said. It closes on Esc and on a click outside it and outside the
 * composer, which stays usable and sends into the thread meanwhile.
 */
export function ChatThreadView({
  sessionId,
  messageId,
  onClose,
  className,
}: {
  sessionId: string;
  /** Any message of the thread. */
  messageId: string;
  onClose: () => void;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
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

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const panel = panelRef.current;
      if (!target || !panel || panel.contains(target)) return;
      if (target.closest?.(`[${KEEPS_CHAT_THREAD_OPEN}]`)) return;
      if (!appTreeOf(panel).contains(target)) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  const messages = (thread.data ?? []).filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const count = messages.length;
  // The newest message is at the bottom, in view.
  useEffect(() => {
    const list = listRef.current;
    if (list && count > 0) list.scrollTop = list.scrollHeight;
  }, [count]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("thread.title")}
      className={cn(
        "flex max-h-[min(60vh,32rem)] flex-col rounded-16 border border-border bg-surface shadow-10",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span className="text-title">{t("thread.title")}</span>
        <IconButton size="sm" label={t("thread.close")} icon={<X />} onClick={onClose} />
      </div>
      <ol ref={listRef} className="flex min-h-0 flex-col gap-2 overflow-y-auto px-4 py-3">
        {messages.map((message) => (
          <li
            key={message.id}
            data-thread-message={message.id}
            className={cn(
              "max-w-[85%] rounded-12 px-3 py-2 text-ui break-words",
              message.role === "user"
                ? "self-end bg-muted"
                : "self-start border border-border bg-background",
            )}
          >
            <ChatMarkdown>{wordsOf(message)}</ChatMarkdown>
          </li>
        ))}
        {thread.isError ? (
          <li className="text-ui text-muted-foreground">{t("thread.loadFailed")}</li>
        ) : null}
      </ol>
    </div>
  );
}
