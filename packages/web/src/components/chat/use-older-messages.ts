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

// Bound first-load root reads to two older pages. `through` can exceed `limit`.
export const CONCIERGE_ROOT_PAGE_TURNS = 60;

/** How far above the viewport the sentinel counts as reached, so older turns arrive before the top does. */
const LOAD_AHEAD_PX = 800;

/** Quiet time that ends one scroll gesture, so the next one may load a page. */
const GESTURE_IDLE_MS = 250;

/** How close to the top, in px, the scroll counts as at the top. */
const TOP_PX = 1;

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
  /** Called with the messages of each older page that loads, once it is merged in. */
  onOlderPage?: (sessionId: string, messages: ChatMessage[]) => void;
  /**
   * Pages load only on demand, as when a chat thread is in focus: the rows
   * outside it are hidden, so a page adds no height and the sentinel would
   * report again until the history ran out. The sentinel then loads nothing,
   * and one page loads for each gesture that pushes up against the top of the
   * scroll: a wheel up, a pull down on a touch screen, or PageUp, Home or the
   * up arrow outside a field. That also holds with too little to scroll.
   */
  onDemand?: boolean;
  /** With `onDemand`, whether the reader already has all they can want: a push then loads nothing. */
  satisfied?: boolean;
}

export interface OlderMessages {
  /** Remembers where a session's older history starts, from a newest-page response. */
  setCursor: (sessionId: string, cursor: string | null) => void;
  /** Whether the session has older turns that are not loaded yet. */
  hasOlder: (sessionId: string) => boolean;
  /** Attach to an element placed at the top of the transcript. */
  sentinelRef: (node: HTMLElement | null) => void;
  /**
   * Loads the page of turns before the oldest loaded one, keeping the viewport
   * on what it shows. With `through`, the page reaches that message however
   * far back it is, in one read.
   */
  loadOlder: (sessionId: string, options?: { through?: string }) => Promise<void>;
}

/**
 * Pages a long session in backwards: the newest page loads with the chat, and
 * older pages load as the guardian scrolls toward the top.
 */
export function useOlderMessages(
  sessionId: string | null,
  {
    pageTurns,
    scroller,
    pinned,
    setMessages,
    onOlderPage,
    onDemand = false,
    satisfied = false,
  }: UseOlderMessagesOptions,
): OlderMessages {
  const [cursors, setCursors] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const cursorsRef = useRef(cursors);
  // Each session's page read in flight.
  const loadingRef = useRef(new Map<string, Promise<void>>());
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

  const readPage = useCallback(
    async (id: string, cursor: string, options: { through?: string }) => {
      setLoading(true);
      try {
        const page = await listSessionMessagePage(id, {
          limit: pageTurns,
          before: cursor,
          ...(options.through ? { through: options.through } : {}),
        });
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
        onOlderPage?.(id, page.messages);
      } catch {
        setRetryBlocked(true);
      } finally {
        loadingRef.current.delete(id);
        setLoading(false);
      }
    },
    [pageTurns, setCursor, setMessages, onOlderPage],
  );

  const loadOlder = useCallback(
    async (id: string, options: { through?: string } = {}): Promise<void> => {
      const inFlight = loadingRef.current.get(id);
      if (inFlight) {
        await inFlight;
        // The page in flight may stop short of the message `through` names,
        // so its own read follows.
        if (!options.through || loadingRef.current.has(id)) return;
      }
      const cursor = cursorsRef.current.get(id);
      if (!cursor) return;
      const read = readPage(id, cursor, options);
      loadingRef.current.set(id, read);
      await read;
    },
    [readPage],
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
    if (onDemand || !sessionId || !sentinel || !scroller || !waiting || loading || retryBlocked)
      return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadOlder(sessionId);
      },
      { root: scroller, rootMargin: `${LOAD_AHEAD_PX}px 0px 0px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onDemand, sessionId, sentinel, scroller, waiting, loading, retryBlocked, loadOlder]);

  // One page for each gesture against the top. Events that follow each other
  // within GESTURE_IDLE_MS are one gesture, momentum included, judged by when
  // the input happened, not when it was handled: a page that is rendering
  // delays the handlers, and must not split a gesture in two. A page that is
  // still on its way is not asked for twice.
  useEffect(() => {
    if (!onDemand || satisfied || !sessionId || !scroller || !waiting) return;
    let loaded = false;
    let last = Number.NEGATIVE_INFINITY;
    const push = (at: number) => {
      if (at - last > GESTURE_IDLE_MS) loaded = false;
      last = at;
      if (loaded || scroller.scrollTop > TOP_PX) return;
      loaded = true;
      void loadOlder(sessionId);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) push(event.timeStamp);
    };
    let touchY = 0;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? 0;
      loaded = false;
      last = event.timeStamp;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (y > touchY) push(event.timeStamp);
      touchY = y;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable]");
      if (
        event.defaultPrevented ||
        event.repeat ||
        typing ||
        !["PageUp", "Home", "ArrowUp"].includes(event.key)
      )
        return;
      loaded = false;
      push(event.timeStamp);
    };
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onDemand, satisfied, sessionId, scroller, waiting, loadOlder]);

  return { setCursor, hasOlder, sentinelRef, loadOlder };
}
