import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { isRenderable } from "@/components/chat/concierge-groups";
import type { ChatMessage } from "@/lib/chat-types";

/** Where a Concierge chat's read mark stood, and how far its history reached, when it opened. */
export interface UnreadAtOpen {
  /** The chat's read mark before the open marked it read: an ISO time, whole seconds. */
  watermark: string;
  /**
   * When the newest message the chat opened with was said, in unix seconds. A
   * message said after it arrived live, and is never unread.
   */
  openedThrough: number;
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
 * The unread agent messages of `messages`, which are in time order, at `open`.
 * The server's rule is the same: a message is unread when it was created after
 * the read mark, and both times have one-second precision, so a message in the
 * same second as the mark is read. A message said after the chat opened is
 * never unread. `hasOlder` says older pages are not all loaded. Returns null
 * when no loaded message is unread.
 *
 * The first unread message is known only once no older page remains, or once
 * the oldest loaded message is at or before the mark, which ends the unread
 * run. Until then `more` is set and `firstId` is null.
 */
export function summarizeUnread(
  messages: ChatMessage[],
  open: UnreadAtOpen,
  hasOlder: boolean,
): UnreadSummary | null {
  const mark = seconds(open.watermark);
  if (Number.isNaN(mark)) return null;
  const isUnread = (message: ChatMessage) => {
    const at = seconds(message.createdAt);
    return at > mark && at <= open.openedThrough;
  };
  const drawn = messages.filter(
    (message) => message.role === "assistant" && isUnread(message) && drawsBubble(message),
  );
  if (drawn.length === 0) return null;
  const oldest = messages.find((message) => message.role !== "trace");
  const more = hasOlder && oldest !== undefined && seconds(oldest.createdAt) > mark;
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
 * `unread` is fixed by the read mark and the history the chat opened with,
 * which `noteOpened` reports. It stays put once the chat is marked read, and
 * the messages that arrive after the open are never unread.
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
  const [openedThrough, setOpenedThrough] = useState<number | null | undefined>(undefined);

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
      setOpenedThrough((current) =>
        current === undefined
          ? messages.some((message) => message.role !== "trace")
            ? Math.max(
                ...messages
                  .filter((message) => message.role !== "trace")
                  .map((message) => seconds(message.createdAt)),
              )
            : null
          : current,
      ),
    [],
  );
  const pendingMark = useCallback(() => request.current, []);
  const unread = useMemo(
    () => (watermark && openedThrough ? { watermark, openedThrough } : null),
    [watermark, openedThrough],
  );
  return { unread, noteOpened, pendingMark };
}
