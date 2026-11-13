import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { isRenderable } from "@/components/chat/concierge-groups";
import type { ChatMessage } from "@/lib/chat-types";

/** What a Concierge chat held, and where its read mark stood, when it opened. */
export interface UnreadAtOpen {
  /** The chat's read mark before the open marked it read: an ISO time, whole seconds. */
  watermark: string;
  /** The ids of the messages the chat opened with, frozen: a message that arrives later is not among them. */
  openIds: ReadonlySet<string>;
  /** The earliest `createdAt` of those messages, in milliseconds. A message older than it came from an older page. */
  oldestAt: number;
}

/** The part of a chat's history that was there when it opened, as {@link UnreadAtOpen} holds it. */
export function openingHistory(
  messages: ChatMessage[],
): Pick<UnreadAtOpen, "openIds" | "oldestAt"> | null {
  const times = messages.map((message) => Date.parse(message.createdAt)).filter(Number.isFinite);
  if (messages.length === 0 || times.length === 0) return null;
  return { openIds: new Set(messages.map((message) => message.id)), oldestAt: Math.min(...times) };
}

/** The unread agent messages of a chat, as far as its loaded history shows them. */
export interface UnreadSummary {
  /** The first unread message the chat draws, or null while it is on an older page or there is none. */
  firstId: string | null;
  /** How many unread agent messages the chat draws among the loaded ones. */
  count: number;
  /** Whether more unread messages wait on an older page, so `count` is a lower bound. */
  more: boolean;
}

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** Whether the Concierge draws `message` as a bubble: it says something and is no model-switch notice. */
function drawsBubble(message: ChatMessage): boolean {
  return (
    isRenderable(message) &&
    !parseMessageEntries(message).some((part) => part.type === "quota_switch")
  );
}

/**
 * The unread agent messages of `messages` at `open`. The server's rule is the
 * same: a message is unread when it was created after the read mark, and both
 * times have one-second precision, so a message in the same second as the mark
 * is read. Each message is judged on its own, because the transcript's order
 * groups messages by turn and is not time order. Only the opening history
 * counts, plus older pages loaded since. A message that arrived after the chat
 * opened is neither, however it sorts. `hasOlder` says older pages are not all
 * loaded. Returns null when nothing is unread.
 */
export function summarizeUnread(
  messages: ChatMessage[],
  open: UnreadAtOpen,
  hasOlder: boolean,
): UnreadSummary | null {
  const mark = seconds(open.watermark);
  if (Number.isNaN(mark)) return null;
  const agent = messages.filter(
    (message) =>
      message.role === "assistant" &&
      (open.openIds.has(message.id) || Date.parse(message.createdAt) < open.oldestAt),
  );
  const drawn = agent.filter(
    (message) => seconds(message.createdAt) > mark && drawsBubble(message),
  );
  if (drawn.length === 0) return null;
  // Unread messages are the newest, so a loaded read one means nothing older is unread.
  const more = hasOlder && !agent.some((message) => seconds(message.createdAt) <= mark);
  return { firstId: more ? null : drawn[0].id, count: drawn.length, more };
}

/** The longest the read mark waits for the chat's own read mark before the chat is marked read anyway. */
const MARK_WAIT_MS = 2000;

/**
 * Remembers what a Concierge chat had unread when it opened. `loadReadMark`
 * asks for the chat's read mark. It runs once, when the chat mounts, and its
 * absence means the chat does no pre-read work. A chat opened without an id
 * is a draft that a first send turns into a chat, and has nothing unread.
 *
 * Two things fix `unread`, and neither changes afterward, even once the chat
 * is marked read: the read mark, and the messages of the history the chat
 * opened with, which `noteOpened` reports. Messages that arrive live after that
 * are never unread.
 */
export function useUnreadAtOpen({
  chatId,
  loadReadMark,
}: {
  chatId: string | null | undefined;
  /** Resolves with `chatId`'s read mark, or null when it has none. Never rejects. */
  loadReadMark?: (chatId: string) => Promise<string | null>;
}): {
  unread: UnreadAtOpen | null;
  /** Reports the history the chat opened with, once. The first report is the one that counts. */
  noteOpened: (messages: ChatMessage[]) => void;
  /**
   * Resolves once the read mark is known, or after {@link MARK_WAIT_MS}. Null
   * when none is on the way. Await it before marking the chat read.
   */
  pendingMark: () => Promise<void> | null;
} {
  const openedAsDraft = useRef(!chatId);
  const request = useRef<Promise<void> | null>(null);
  const [watermark, setWatermark] = useState<string | null>(null);
  const [opening, setOpening] = useState<ReturnType<typeof openingHistory> | undefined>(undefined);

  // The request starts in an effect that runs before the one that loads the
  // chat's messages, and nothing marks the chat read before that load.
  useEffect(() => {
    if (!chatId || !loadReadMark || openedAsDraft.current || request.current) return;
    request.current = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, MARK_WAIT_MS);
      void loadReadMark(chatId)
        .then(setWatermark)
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  }, [chatId, loadReadMark]);

  const noteOpened = useCallback(
    (messages: ChatMessage[]) =>
      setOpening((current) => (current === undefined ? openingHistory(messages) : current)),
    [],
  );
  const pendingMark = useCallback(() => request.current, []);
  const unread = useMemo(
    () => (watermark && opening ? { watermark, ...opening } : null),
    [watermark, opening],
  );
  return { unread, noteOpened, pendingMark };
}
