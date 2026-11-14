import { MessageSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { IconButton } from "@/components/ui/icon-button";
import { useQuery } from "@tanstack/react-query";
import {
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { chatSessionTopic, useLiveEvents } from "@/hooks/use-live-events";
import { listChatThreadMessages } from "@/lib/chat-api";
import type { ChatMessage } from "@/lib/chat-types";
import { cn } from "@/lib/utils";
import { findMessageAnchor } from "./reply/reply-source";
import {
  LANDING_MS,
  messageBubbles,
  playLanding,
  THREAD_FADE_MS,
  threadAnchor,
} from "./reply/thread-anchor";

/** The query key of one chat thread, named by any of its messages. */
export function chatThreadQueryKey(sessionId: string, messageId: string) {
  return ["chat-thread", sessionId, messageId] as const;
}

const anyEvent = z.unknown();

/** How much of the opened message stays above the composer, at least. */
const KEEP_IN_VIEW_PX = 48;

// A press on one of these belongs to the thread's content, not the blurred
// area around it: any bubble of a message, a card, a bubble's details, the
// header's pieces.
const CONTENT =
  "[data-concierge-bubble-part],[data-timeline-anchor],[data-chat-card-message],[data-bubble-toolbar],[data-concierge-header-badge],[data-concierge-header-name],[data-concierge-header-activity],a,button,input,textarea,select,[role=menu]";

/**
 * One chat thread of a Concierge chat on its own (docs/domains/chats.md#chat-thread),
 * laid over the transcript column. The chat behind it is all but covered,
 * only a blurred trace of it showing through; `header` floats on top, and the thread's messages, drawn
 * by `renderMessages`, sit at the bottom above the composer and scroll when
 * long. With `originTop`, the message it was opened from keeps the place it
 * had in the timeline instead (see `threadAnchor`). New messages in the
 * thread appear as they are said. It fades in, and closes at once.
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
  originTop,
  className,
}: {
  sessionId: string;
  /** Any message of the thread. */
  messageId: string;
  onClose: () => void;
  header?: ReactNode;
  renderMessages: (messages: ChatMessage[]) => ReactNode;
  floor?: HTMLElement | null;
  /**
   * Where `messageId` sat in the timeline when the view opened, as a
   * viewport y, read once on open. Null or absent: the thread sits at the
   * bottom.
   */
  originTop?: () => number | null;
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
  //
  // Opened from a message, the view holds that message where it was instead,
  // until the reader scrolls or a new message arrives.
  const following = useRef(true);
  const shownCount = useRef(0);
  const origin = useRef<number | null | undefined>(undefined);
  if (origin.current === undefined) origin.current = originTop?.() ?? null;
  const anchoring = useRef(origin.current !== null);
  const [lift, setLift] = useState(0);
  const placedAt = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || count === 0) return;
    if (shownCount.current !== 0 && count !== shownCount.current) {
      following.current = true;
      anchoring.current = false;
      setLift(0);
    }
    shownCount.current = count;
    const copy = anchoring.current ? findMessageAnchor(list, messageId) : null;
    if (copy && origin.current !== null && contentRef.current) {
      const listTop = list.getBoundingClientRect().top;
      const slack = Number.parseFloat(getComputedStyle(contentRef.current).marginTop) || 0;
      // The message stays below the header and its first lines above the
      // composer's floor.
      const minTop = Number.parseFloat(getComputedStyle(list).paddingTop) || 0;
      const maxTop = list.clientHeight - floorHeight - KEEP_IN_VIEW_PX;
      const place = threadAnchor({
        desired: (origin.current ?? 0) - listTop,
        minTop,
        maxTop,
        // Measured back to no scroll and no lift: a lift takes its height
        // out of the free space above.
        copyTop: copy.getBoundingClientRect().top - listTop + list.scrollTop + lift,
        slack: slack + lift,
        viewHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
      });
      if (place.lift !== lift) setLift(place.lift);
      list.scrollTop = place.scrollTop;
      placedAt.current = list.scrollTop;
      following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
      return;
    }
    if (following.current) list.scrollTop = list.scrollHeight;
  }, [count, floorHeight, lift, messageId]);
  // The thread's copy of the message it opened from gets the same brief tint
  // a jump gives, once the view has faded in, so the eye finds it. It counts
  // as given only once it shows: a cleanup before then, as when the thread
  // comes from the cache and the view's effects run twice on mount, leaves it
  // to the next run.
  const landed = useRef(false);
  const shown = count > 0;
  useEffect(() => {
    const list = listRef.current;
    if (!list || !shown || landed.current) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    // The whole message lands, every bubble of it, not only its first.
    let copies: HTMLElement[] = [];
    const start = window.setTimeout(
      () => {
        copies = messageBubbles(list, messageId);
        if (copies.length === 0) return;
        landed.current = true;
        for (const copy of copies) playLanding(copy);
      },
      still ? 0 : THREAD_FADE_MS,
    );
    const end = window.setTimeout(
      () => {
        for (const copy of copies) copy.removeAttribute("data-timeline-landed");
      },
      (still ? 0 : THREAD_FADE_MS) + LANDING_MS,
    );
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(end);
      for (const copy of copies) copy.removeAttribute("data-timeline-landed");
    };
  }, [shown, messageId]);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    // The view's own placement scrolls too; only the reader's scroll lets go.
    if (placedAt.current === null || Math.abs(list.scrollTop - placedAt.current) > 1) {
      anchoring.current = false;
      placedAt.current = null;
    }
    following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
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
      {/* Each layer fades on its own: an ancestor's opacity would cut the
          backdrop's blur off from the chat behind it while it fades. The
          backdrop is near-opaque, so the thread reads the same wherever the
          blur is lost; the blur only softens the little that shows through. */}
      <div
        aria-hidden
        data-chat-thread-fade
        className="absolute inset-0 bg-chat-canvas/95 backdrop-blur-xl"
      />
      {/* `isolate` keeps a blend mode in a message (an avatar's ring) inside
          the list. Without it the blend isolates the whole view, and the
          backdrop then blurs only the view itself, not the chat behind. */}
      <div
        ref={listRef}
        onScroll={onScroll}
        data-chat-thread-fade
        className="scrollbar-idle-hidden relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain concierge-header-clear"
        style={{ paddingBottom: floorHeight + lift }}
      >
        <div ref={contentRef} className="mt-auto">
          {renderMessages(messages)}
          {thread.isError ? (
            <p className="px-3 text-center text-ui text-muted-foreground md:px-6">
              {t("thread.loadFailed")}
            </p>
          ) : null}
        </div>
      </div>
      {header ? <div data-chat-thread-fade>{header}</div> : null}
    </div>
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
