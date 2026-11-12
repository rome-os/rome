import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/chat-types";

/** What the guardian had not read when a Concierge chat opened. */
export interface UnreadAtOpen {
  /** Agent messages the server counted, at most `CONCIERGE_UNREAD_CAP`. */
  count: number;
  /** The newest message the chat held then, so later arrivals never count. */
  newestId: string;
}

/**
 * The id of the first message that was unread at `open`, or null when it is
 * not among `messages` yet because it sits on an older page. `messages` is the
 * chat's ordered transcript. The server counts agent messages (role
 * `assistant`), so the first unread one is the `open.count`-th from the end of
 * those that existed at open. When the count passes the server's cap, this is
 * the cap-th from the end.
 */
export function firstUnreadMessageId(messages: ChatMessage[], open: UnreadAtOpen): string | null {
  const end = messages.findIndex((message) => message.id === open.newestId);
  const agent = (end === -1 ? messages : messages.slice(0, end + 1)).filter(
    (message) => message.role === "assistant",
  );
  if (open.count <= 0 || agent.length < open.count) return null;
  return agent[agent.length - open.count].id;
}

/** The longest the read mark waits for the count before the chat is marked read anyway. */
const COUNT_WAIT_MS = 2000;

/**
 * Remembers what was unread when a chat opened, and gives the chat's read mark
 * something to wait for until it knows. Only a chat opened with an id counts:
 * a draft that a first send turns into a chat has nothing unread. The count
 * is asked of every such chat, because a Concierge topic chat opened from a
 * cold start is not known as one yet. The request is the Concierge chat
 * list's own, so it costs no extra call, and a chat outside the list counts 0.
 *
 * `newestId` is the id of the newest message loaded. The first value it takes
 * after the count arrives fixes `unread`, which then never changes while the
 * chat stays open, even after the chat is marked read.
 */
export function useUnreadAtOpen({
  chatId,
  newestId,
  countUnread,
}: {
  chatId: string | null | undefined;
  newestId: string | null;
  /** Asks the server how many agent messages `chatId` has unread right now. Without it, nothing is counted. */
  countUnread?: (chatId: string) => Promise<number>;
}): {
  unread: UnreadAtOpen | null;
  /**
   * Resolves once the count is known, or after {@link COUNT_WAIT_MS}. Null when
   * no count is on the way. Await it before marking the chat read.
   */
  pendingCount: () => Promise<void> | null;
} {
  const openedAsDraft = useRef(!chatId);
  const request = useRef<Promise<void> | null>(null);
  const [count, setCount] = useState(0);
  const [unread, setUnread] = useState<UnreadAtOpen | null>(null);

  // The request starts in an effect that runs before the one that loads the
  // chat's messages, and nothing marks the chat read before that load.
  useEffect(() => {
    if (!chatId || !countUnread || openedAsDraft.current || request.current) return;
    request.current = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, COUNT_WAIT_MS);
      void countUnread(chatId)
        .then(setCount)
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  }, [chatId, countUnread]);

  useEffect(() => {
    if (unread || count <= 0 || !newestId) return;
    setUnread({ count, newestId });
  }, [unread, count, newestId]);

  const pendingCount = useCallback(() => request.current, []);
  return { unread, pendingCount };
}
