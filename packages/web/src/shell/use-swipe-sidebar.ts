import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";

/**
 * On a phone, a swipe right on the page drags the sidebar out under the
 * finger, the way the Claude mobile app reveals its chat list. The sidebar
 * follows the finger, the page slides right with it under the scrim, and on
 * release it settles open or shut by distance and speed. A swipe left on the
 * open sidebar or the dimmed page drags it back.
 *
 * The gesture listens on the shell's frame, so a sheet or dialog portaled to
 * the document body never starts one. Where a touch starts in the frame, the
 * gesture yields to whatever already owns sideways movement there or sits
 * over the page as its own surface: a sideways scroller not yet at its left
 * edge (code blocks, tables, chip rows), anything whose `touch-action` keeps
 * sideways panning for itself (a diagram's pan and zoom, a carousel), a text
 * field or editable region, a dialog, and a fixed overlay. It reads the
 * touch's composed path, so this holds inside the shadow roots apps mount in.
 * Mobile Safari keeps the screen's left edge for its own back gesture, so
 * there a swipe starts a little way in.
 */

/** The sidebar's `w-64`. */
const WIDTH = 256;
/** Travel before the gesture commits to an axis. */
const LOCK = 10;
/** Share of the width past which a release opens the sidebar. */
const OPEN_AT = 0.35;
/** px/ms past which a release opens or shuts it whatever the distance. */
const FLICK = 0.4;
/** The settle, and the page's `duration-200` slide when React moves it. */
export const SLIDE_MS = 200;
const PHONE = "(width < 48rem)";

/**
 * Whether the touch starts on something that owns sideways movement or lies
 * over the page. `path` is the touch's composed path, read up to the frame.
 */
function yieldsTo(path: readonly EventTarget[], frame: HTMLElement): boolean {
  for (const node of path) {
    if (node === frame) break;
    if (!(node instanceof Element)) continue;
    if (node instanceof HTMLElement && node.isContentEditable) return true;
    if (node.matches("input, textarea, select, [role=dialog], [aria-modal=true]")) return true;
    const style = getComputedStyle(node);
    if (style.position === "fixed") return true;
    // `auto` and `manipulation` leave panning to the page; a value that names
    // `pan-x` leaves sideways panning to it. Any other value, `none` or
    // `pan-y` say, means the element handles sideways movement itself.
    if (!/^(auto|manipulation)$|pan-x/.test(style.touchAction)) return true;
    const scrolls =
      /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
    if (scrolls && node.scrollLeft > 0) return true;
  }
  return false;
}

export function useSwipeSidebar({
  disabled,
  open,
  setOpen,
  sidebar,
  page,
  scrim,
  frame,
}: {
  disabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  sidebar: RefObject<HTMLElement | null>;
  page: RefObject<HTMLElement | null>;
  scrim: RefObject<HTMLElement | null>;
  /** The page's container. It clips sideways while the page is pushed. */
  frame: RefObject<HTMLElement | null>;
}) {
  // Read through a ref, so a change of `open` does not swap the listeners in
  // the middle of a gesture, and a gesture can commit and carry on in one
  // event. A layout effect, so `flushSync` brings it up to date.
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const root = frame.current;
    if (disabled || !root || typeof window.matchMedia !== "function") return;
    const phone = window.matchMedia(PHONE);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");

    let start: { x: number; y: number } | null = null;
    /** `open` when the gesture started. */
    let from = false;
    let axis: "x" | "y" | null = null;
    let progress = 0;
    let last = { x: 0, t: 0 };
    let velocity = 0;
    /** A released gesture still settling, and where it settles. */
    let settling: { timer: number; next: boolean } | null = null;

    // `translate`, not `transform`: the classes these elements carry at rest
    // are Tailwind translate utilities, which set the `translate` property, and
    // the two properties would compose rather than replace.
    const paint = (p: number, animate: boolean) => {
      const transition =
        animate && !still.matches
          ? `translate ${SLIDE_MS}ms ease-out, opacity ${SLIDE_MS}ms ease-out`
          : "none";
      for (const [el, style] of [
        [sidebar.current, { translate: `${(p - 1) * 100}% 0` }],
        [page.current, { translate: p > 0 ? `${p * WIDTH}px 0` : "none" }],
        [scrim.current, { opacity: String(p) }],
      ] as const) {
        if (!el) continue;
        el.style.transition = transition;
        Object.assign(el.style, style);
      }
      // A pushed page reaches past the screen's right edge. Clipping it keeps
      // the document from scrolling sideways, and only while it is pushed, so
      // a page that overflows at rest still shows it.
      root.style.overflowX = p > 0 ? "clip" : "";
    };
    // Hand the resting state back to the classes React renders.
    const release = () => {
      for (const el of [sidebar.current, page.current, scrim.current]) {
        if (!el) continue;
        el.style.transition = "";
        el.style.translate = "";
        el.style.opacity = "";
      }
      root.style.overflowX = "";
    };
    // Commit first, so the classes already say where the elements rest when
    // the inline styles come off. The other order shows the old state for a
    // frame.
    const settle = () => {
      if (!settling) return;
      window.clearTimeout(settling.timer);
      const { next } = settling;
      settling = null;
      flushSync(() => setOpen(next));
      release();
    };

    const onStart = (event: TouchEvent) => {
      start = null;
      if (!phone.matches || event.touches.length !== 1) return;
      // A touch during the settle lands it at once, so this gesture starts
      // from where the last one left the sidebar.
      settle();
      from = openRef.current;
      if (!from && yieldsTo(event.composedPath(), root)) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY };
      last = { x: touch.clientX, t: event.timeStamp };
      axis = null;
      progress = from ? 1 : 0;
      velocity = 0;
    };

    const onMove = (event: TouchEvent) => {
      if (!start) return;
      // Opened or closed some other way mid-gesture: that wins.
      if (openRef.current !== from) {
        start = null;
        release();
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!axis) {
        if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
        // Sideways, and toward where the sidebar can go. Anything else is a
        // scroll, and the gesture lets it be one.
        const sideways = Math.abs(dx) > Math.abs(dy) * 1.5;
        axis = sideways && (from ? dx < 0 : dx > 0) ? "x" : "y";
        if (axis === "y") {
          start = null;
          return;
        }
      }
      event.preventDefault();
      velocity = (touch.clientX - last.x) / Math.max(event.timeStamp - last.t, 1);
      last = { x: touch.clientX, t: event.timeStamp };
      progress = Math.min(Math.max((from ? 1 : 0) + dx / WIDTH, 0), 1);
      paint(progress, false);
    };

    const onEnd = () => {
      if (!start || axis !== "x") {
        start = null;
        return;
      }
      start = null;
      const next = velocity > FLICK ? true : velocity < -FLICK ? false : progress > OPEN_AT;
      paint(next ? 1 : 0, true);
      settling = { next, timer: window.setTimeout(settle, still.matches ? 0 : SLIDE_MS) };
    };

    root.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: once a swipe has the sideways axis, it keeps the page from
    // scrolling under it. Scoped to the frame, so sheets and dialogs portaled
    // to the body scroll without waiting on it.
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
      if (settling) window.clearTimeout(settling.timer);
      settling = null;
      release();
    };
  }, [disabled, setOpen, sidebar, page, scrim, frame]);
}
