import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { listSessionMessagePage } from "@/lib/chat-api";
import { mergeFetchedChatMessages } from "@/lib/chat-message-ordering";
import type { ChatMessage } from "@/lib/chat-types";

/**
 * Turns per page. A page is what the transcript renders at once, so it is
 * sized to fill a few screens and no more: a regular chat's turns carry long
 * answers and cost the most to render, a Concierge turn is a few short
 * bubbles.
 */
export const CHAT_PAGE_TURNS = 10;
export const CONCIERGE_PAGE_TURNS = 30;

/** How far above the viewport the sentinel counts as reached, so older turns arrive before the top does. */
const LOAD_AHEAD_PX = 800;

/** Wait after a failed page before the sentinel tries again. */
const RETRY_DELAY_MS = 3_000;

/**
 * Where the viewport must be after older rows are inserted above it. The rows
 * add `grown` px of height above the content the guardian is reading, so the
 * same content sits `grown` px lower. A browser that anchors scroll position
 * has already moved by then, and the result is the same.
 */
export function scrollTopAfterPrepend(
  before: { scrollTop: number; scrollHeight: number },
  now: {
    scrollTop: number;
    scrollHeight: number;
  },
): number {
  return Math.max(now.scrollTop, before.scrollTop + (now.scrollHeight - before.scrollHeight));
}

interface UseOlderMessagesOptions {
  /** Turns per page; see {@link CHAT_PAGE_TURNS}. */
  pageTurns: number;
  /** The element that scrolls the transcript. */
  scroller: HTMLElement | null;
  /** Whether the viewport follows the newest message. A pinned viewport needs no anchoring. */
  pinned: boolean;
  setMessages: Dispatch<SetStateAction<Map<string, ChatMessage[]>>>;
}

export interface OlderMessages {
  /** Remembers where a session's older history starts, from a newest-page response. */
  setCursor: (sessionId: string, cursor: string | null) => void;
  /** Whether the session has older turns that are not loaded yet. */
  hasOlder: (sessionId: string) => boolean;
  /** Attach to an element placed at the top of the transcript. */
  sentinelRef: (node: HTMLElement | null) => void;
  /** Loads the page of turns before the oldest loaded one, keeping the viewport on what it shows. */
  loadOlder: (sessionId: string) => Promise<void>;
}

/**
 * Pages a long session in backwards: the newest page loads with the chat, and
 * older pages load as the guardian scrolls toward the top.
 */
export function useOlderMessages(
  sessionId: string | null,
  { pageTurns, scroller, pinned, setMessages }: UseOlderMessagesOptions,
): OlderMessages {
  const [cursors, setCursors] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const cursorsRef = useRef(cursors);
  const loadingRef = useRef(new Set<string>());
  const [loading, setLoading] = useState(false);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const scrollerRef = useRef(scroller);
  scrollerRef.current = scroller;

  const [anchorTick, setAnchorTick] = useState(0);
  const anchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);

  // Runs in the commit that inserted the older rows, before paint, so the
  // viewport never shows the jump.
  useLayoutEffect(() => {
    const before = anchorRef.current;
    const el = scrollerRef.current;
    anchorRef.current = null;
    if (!before || !el) return;
    const target = scrollTopAfterPrepend(before, el);
    if (target !== el.scrollTop) el.scrollTop = target;
  }, [anchorTick]);

  const setCursor = useCallback((id: string, cursor: string | null) => {
    if (cursorsRef.current.get(id) === cursor && cursorsRef.current.has(id)) return;
    const next = new Map(cursorsRef.current);
    next.set(id, cursor);
    cursorsRef.current = next;
    setCursors(next);
  }, []);

  const hasOlder = useCallback((id: string) => !!cursors.get(id), [cursors]);

  const loadOlder = useCallback(
    async (id: string) => {
      const cursor = cursorsRef.current.get(id);
      if (!cursor || loadingRef.current.has(id)) return;
      loadingRef.current.add(id);
      setLoading(true);
      try {
        const page = await listSessionMessagePage(id, { limit: pageTurns, before: cursor });
        // A newer response may have restarted the history while this one flew.
        if (!page || cursorsRef.current.get(id) !== cursor) return;
        const el = scrollerRef.current;
        if (el && !pinnedRef.current) {
          anchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
          setAnchorTick((tick) => tick + 1);
        }
        setMessages((prev) => {
          const next = new Map(prev);
          next.set(id, mergeFetchedChatMessages(next.get(id) ?? [], page.messages));
          return next;
        });
        setCursor(id, page.nextCursor);
      } catch {
        setRetryBlocked(true);
      } finally {
        loadingRef.current.delete(id);
        setLoading(false);
      }
    },
    [pageTurns, setCursor, setMessages],
  );

  useEffect(() => {
    if (!retryBlocked) return;
    const timer = setTimeout(() => setRetryBlocked(false), RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [retryBlocked]);

  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const sentinelRef = useCallback((node: HTMLElement | null) => setSentinel(node), []);
  const waiting = !!sessionId && !!cursors.get(sessionId);

  // Observing again after each page re-reports a sentinel that is still in
  // range, so a short transcript keeps loading until it fills the viewport.
  useEffect(() => {
    if (!sessionId || !sentinel || !scroller || !waiting || loading || retryBlocked) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadOlder(sessionId);
      },
      { root: scroller, rootMargin: `${LOAD_AHEAD_PX}px 0px 0px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sessionId, sentinel, scroller, waiting, loading, retryBlocked, loadOlder]);

  return { setCursor, hasOlder, sentinelRef, loadOlder };
}
