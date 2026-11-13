import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { isRenderable } from "@/components/chat/concierge-groups";
import type { ChatMessage } from "@/lib/chat-types";

/** What a Concierge chat held, and where its read mark stood, when it opened. */
export interface UnreadAtOpen {
  /** The chat's read mark before the open marked it read: an ISO time, whole seconds. */
  watermark: string;
  /** The newest message of the history the chat opened with. Nothing after it is unread. */
  newestId: string;
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
 * The agent messages of `messages` that were unread at `open`. The server's
 * rule is the same: a message is unread when it was created after the read
 * mark, and both times have one-second precision, so a message in the same
 * second as the mark is read. Only the opening history counts, up to
 * `open.newestId`, so a message that arrives later is never unread. `messages`
 * is the chat's ordered transcript, and `hasOlder` says older pages are not
 * loaded. Returns null when nothing is unread.
 */
export function summarizeUnread(
  messages: ChatMessage[],
  open: UnreadAtOpen,
  hasOlder: boolean,
): UnreadSummary | null {
  const end = messages.findIndex((message) => message.id === open.newestId);
  const mark = seconds(open.watermark);
  if (end === -1 || Number.isNaN(mark)) return null;
  const agent = messages.slice(0, end + 1).filter((message) => message.role === "assistant");
  const first = agent.findIndex((message) => seconds(message.createdAt) > mark);
  if (first === -1) return null;
  const drawn = agent.slice(first).filter(drawsBubble);
  // The loaded history starts inside the unread run, so it may reach back further.
  const more = first === 0 && hasOlder;
  if (drawn.length === 0) return null;
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
 * is marked read: the read mark, and the newest message of the history the
 * chat opened with, which `noteOpened` reports. Messages that arrive live
 * after that are never unread.
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
  /** Reports the newest message of the history the chat opened with, once. */
  noteOpened: (newestId: string | null) => void;
  /**
   * Resolves once the read mark is known, or after {@link MARK_WAIT_MS}. Null
   * when none is on the way. Await it before marking the chat read.
   */
  pendingMark: () => Promise<void> | null;
} {
  const openedAsDraft = useRef(!chatId);
  const request = useRef<Promise<void> | null>(null);
  const [watermark, setWatermark] = useState<string | null>(null);
  const [newestId, setNewestId] = useState<string | null | undefined>(undefined);

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
    (id: string | null) => setNewestId((current) => (current === undefined ? id : current)),
    [],
  );
  const pendingMark = useCallback(() => request.current, []);
  const unread = useMemo(
    () => (watermark && newestId ? { watermark, newestId } : null),
    [watermark, newestId],
  );
  return { unread, noteOpened, pendingMark };
}
