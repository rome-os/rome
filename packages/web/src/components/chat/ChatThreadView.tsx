import { useQuery } from "@tanstack/react-query";
import {
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { chatSessionTopic, useLiveEvents } from "@/hooks/use-live-events";
import { listChatThreadMessages } from "@/lib/chat-api";
import type { ChatMessage } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

/** The query key of one chat thread, named by any of its messages. */
export function chatThreadQueryKey(sessionId: string, messageId: string) {
  return ["chat-thread", sessionId, messageId] as const;
}

const anyEvent = z.unknown();

// A press on one of these belongs to the thread's content, not the blurred
// area around it: any bubble of a message, a card, a bubble's details, the
// header's pieces.
const CONTENT =
  "[data-concierge-bubble-part],[data-timeline-anchor],[data-chat-card-message],[data-bubble-toolbar],[data-concierge-header-badge],[data-concierge-header-pill],a,button,input,textarea,select,[role=menu]";

/**
 * One chat thread of a Concierge chat on its own (docs/domains/chats.md#chat-thread),
 * laid over the transcript column. The chat behind it stays in view, blurred
 * and lightly dimmed; `header` floats on top, and the thread's messages, drawn
 * by `renderMessages`, sit at the bottom above the composer and scroll when
 * long. New messages in the thread appear as they are said.
 *
 * The composer is not part of it: `floor` is the element holding it, whose
 * height the messages keep clear of. It closes on Esc and on a press on the
 * blurred area, not on the messages, the sidebar or the tool pane.
 */
export function ChatThreadView({
  sessionId,
  messageId,
  onClose,
  header,
  renderMessages,
  floor = null,
  className,
}: {
  sessionId: string;
  /** Any message of the thread. */
  messageId: string;
  onClose: () => void;
  header?: ReactNode;
  renderMessages: (messages: ChatMessage[]) => ReactNode;
  floor?: HTMLElement | null;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const listRef = useRef<HTMLDivElement>(null);
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
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The composer's floor rides over the bottom of the column, so the last
  // message keeps clear of it however tall the draft grows.
  const [floorHeight, setFloorHeight] = useState(0);
  useEffect(() => {
    if (!floor) return;
    const measure = () => setFloorHeight(floor.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(floor);
    return () => observer.disconnect();
  }, [floor]);

  const messages = (thread.data ?? []).filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const count = messages.length;
  // The newest message is at the bottom, in view: when a message arrives, and
  // when the composer's floor is measured or grows while the thread is read
  // at its bottom. A cached thread draws its messages before the floor is
  // measured, so the first scroll alone would leave the newest behind it.
  const following = useRef(true);
  const shownCount = useRef(0);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || count === 0) return;
    if (count !== shownCount.current) following.current = true;
    shownCount.current = count;
    if (following.current) list.scrollTop = list.scrollHeight;
  }, [count, floorHeight]);
  const onScroll = () => {
    const list = listRef.current;
    if (list) following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // A layer the thread's content opened in a portal (a popover, a menu)
    // bubbles here through React, though it lies outside the overlay.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if ((event.target as Element).closest(CONTENT)) return;
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label={t("thread.title")}
      data-chat-thread-view
      onPointerDown={onPointerDown}
      className={cn("absolute inset-0 z-20 flex flex-col", className)}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-chat-canvas/90 backdrop-blur-xl supports-[backdrop-filter]:bg-chat-canvas/75"
      />
      <div
        ref={listRef}
        onScroll={onScroll}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain concierge-header-clear"
        style={{ paddingBottom: floorHeight }}
      >
        <div className="mt-auto">
          {renderMessages(messages)}
          {thread.isError ? (
            <p className="px-3 text-center text-ui text-muted-foreground md:px-6">
              {t("thread.loadFailed")}
            </p>
          ) : null}
        </div>
      </div>
      {header}
    </div>
  );
}
