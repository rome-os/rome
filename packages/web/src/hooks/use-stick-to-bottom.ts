import { useCallback, useEffect, useRef, useState } from "react";
import { findScrollableYAncestor } from "@/lib/scroll-container";

// A reusable "keep the viewport pinned to the bottom" hook, written for chat /
// log surfaces where content grows (streaming text, async images, resizing
// composers) faster than React re-renders.
//
// Why a hook and not a one-off effect: the failure mode that plagues hand-rolled
// auto-scroll is treating "am I at the bottom?" as a boolean that only updates
// on `scroll` events. Content growing taller does NOT fire a scroll event, so
// that boolean goes stale and the view silently stops following. The fix is a
// ResizeObserver on the content: every height change re-pins while the user is
// stuck, and an actual user scroll away is the only thing that releases the pin.
//
// Scroller-agnostic by design. Attach `contentRef` to the growing content and
// the hook finds the element that ACTUALLY scrolls it — whether that's a nested
// `overflow:auto` container (e.g. a grid cell) or the window/document. It
// resolves that the same way `scrollIntoView` does: the nearest ancestor that
// both permits vertical scroll AND currently overflows (so a styled-but-not-
// overflowing wrapper is skipped in favour of the real bounded scroller above
// it). Pass `scrollRef` to name the container explicitly and skip detection.

export interface UseStickToBottomOptions {
  /** Distance from the bottom (px) that still counts as "stuck". Default 96. */
  thresholdPx?: number;
  /** Whether to begin pinned to the bottom. Default true. */
  initialStuck?: boolean;
}

export interface UseStickToBottom {
  /** Optional: attach to the scroll container to skip ancestor detection. */
  scrollRef: (node: HTMLElement | null) => void;
  /** Attach to the element whose height changes (wraps the growing content). */
  contentRef: (node: HTMLElement | null) => void;
  /** True while the viewport is within `thresholdPx` of the bottom. */
  isAtBottom: boolean;
  /** Jump to the bottom and re-engage stickiness (e.g. on send / session switch). */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

/** How far the viewport's bottom edge sits above the content's bottom edge. */
export function distanceToBottom(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

function readMetrics(scroller: HTMLElement | Window) {
  if (scroller === window) {
    return {
      scrollTop: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: window.innerHeight,
    };
  }
  const el = scroller as HTMLElement;
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
}

// How long after a real user gesture (wheel/touch/pointer/key) a resulting
// scroll still counts as "the user scrolling". Outside this window a scroll is
// treated as programmatic (autofocus, .scrollIntoView, our own pin).
const USER_INTENT_WINDOW_MS = 300;

export function useStickToBottom({
  thresholdPx = 96,
  initialStuck = true,
}: UseStickToBottomOptions = {}): UseStickToBottom {
  const [isAtBottom, setIsAtBottom] = useState(initialStuck);
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
  const explicitScrollRef = useRef<HTMLElement | null>(null);
  const [explicitScrollEl, setExplicitScrollEl] = useState<HTMLElement | null>(null);
  // Stickiness intent, read inside the ResizeObserver without re-subscribing.
  const stuckRef = useRef(initialStuck);
  // Set by real user gestures; lets the scroll handler tell a deliberate
  // scroll-away (release the pin) from a programmatic one like an interactive
  // component autofocusing an input mid-card (which must NOT release the pin).
  const lastUserGestureRef = useRef(0);

  const scrollRef = useCallback((node: HTMLElement | null) => {
    explicitScrollRef.current = node;
    setExplicitScrollEl(node);
  }, []);
  const contentRef = useCallback((node: HTMLElement | null) => setContentEl(node), []);

  // The element (or window) that actually scrolls `contentEl`, resolved lazily:
  // a container only becomes the scroller once its content overflows, so this is
  // re-evaluated at every read rather than cached.
  const resolveScroller = useCallback((): HTMLElement | Window => {
    if (explicitScrollRef.current) return explicitScrollRef.current;
    if (!contentEl) return window;
    return (findScrollableYAncestor(contentEl, { fallback: null }) as HTMLElement | null) ?? window;
  }, [contentEl]);

  const jumpToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      const scroller = resolveScroller();
      if (scroller === window) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
      } else {
        const el = scroller as HTMLElement;
        el.scrollTo({ top: el.scrollHeight, behavior });
      }
    },
    [resolveScroller],
  );

  const setStuck = useCallback((value: boolean) => {
    stuckRef.current = value;
    setIsAtBottom(value);
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      setStuck(true);
      jumpToBottom(behavior);
    },
    [jumpToBottom, setStuck],
  );

  // Record real user gestures so the scroll handler can distinguish a deliberate
  // scroll from a programmatic one. Capture + passive so we see them before any
  // app component can stop propagation. performance.now() is fine in app code.
  useEffect(() => {
    const mark = () => {
      lastUserGestureRef.current = performance.now();
    };
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("wheel", mark, opts);
    window.addEventListener("touchstart", mark, opts);
    window.addEventListener("touchmove", mark, opts);
    window.addEventListener("pointerdown", mark, opts);
    window.addEventListener("keydown", mark, { capture: true });
    return () => {
      window.removeEventListener("wheel", mark, opts);
      window.removeEventListener("touchstart", mark, opts);
      window.removeEventListener("touchmove", mark, opts);
      window.removeEventListener("pointerdown", mark, opts);
      window.removeEventListener("keydown", mark, { capture: true });
    };
  }, []);

  // Intent tracking. One capture-phase listener on `document` sees scroll from
  // ANY scroller: viewport scroll fires on `document`, a nested container's
  // scroll fires on the element (scroll doesn't bubble, but capture still sees
  // it). We only react to the scroller that owns our content, so an unrelated
  // list scrolling elsewhere doesn't toggle our pin.
  useEffect(() => {
    const handleScroll = (event: Event) => {
      const scroller = resolveScroller();
      const isOurs =
        scroller === window
          ? event.target === document ||
            event.target === document.documentElement ||
            event.target === document.body
          : event.target === scroller;
      if (!isOurs) return;
      const atBottom = distanceToBottom(readMetrics(scroller)) <= thresholdPx;
      const userDriven = performance.now() - lastUserGestureRef.current <= USER_INTENT_WINDOW_MS;
      if (userDriven) {
        // The user is scrolling: they may release the pin or scroll back to re-engage.
        setStuck(atBottom);
      } else if (stuckRef.current && !atBottom) {
        // Programmatic drift while stuck (e.g. a component autofocused an input,
        // or our own pin landed a hair short) — snap back instead of releasing.
        jumpToBottom("auto");
      }
    };
    document.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", handleScroll, { capture: true });
  }, [resolveScroller, thresholdPx, setStuck, jumpToBottom]);

  // The core fix: re-pin on every content resize while stuck. Height changes
  // don't emit scroll events, so this is what keeps the view glued to the
  // bottom through streaming, late-loading media, and composer growth. The RO
  // also fires once on observe, which pins the initial layout. It runs after
  // layout and before paint, so there is no visible lag.
  //
  // A named scroller is observed too: when it shrinks, as it does when an
  // on-screen keyboard opens under a chat, its scrollTop stays put and the
  // newest content drops below its visible bottom without any scroll event.
  useEffect(() => {
    if (!contentEl && !explicitScrollEl) return;
    const observer = new ResizeObserver(() => {
      if (stuckRef.current) jumpToBottom("auto");
    });
    if (contentEl) observer.observe(contentEl);
    if (explicitScrollEl) observer.observe(explicitScrollEl);
    return () => observer.disconnect();
  }, [contentEl, explicitScrollEl, jumpToBottom]);

  return { scrollRef, contentRef, isAtBottom, scrollToBottom };
}
