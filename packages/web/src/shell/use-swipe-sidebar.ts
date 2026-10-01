import { type RefObject, useEffect } from "react";
import { flushSync } from "react-dom";

/**
 * On a phone, a swipe right anywhere drags the sidebar out under the finger,
 * the way the Claude mobile app reveals its chat list. The sidebar follows the
 * finger, the page slides right with it under the scrim, and on release it
 * settles open or shut by distance and speed. A swipe left on the open
 * sidebar or the dimmed page drags it back.
 *
 * A swipe yields to whatever already owns sideways movement where it starts:
 * a sideways scroller not yet at its left edge (code blocks, tables, chip
 * rows), anything with `touch-action: none` (a diagram's pan and zoom), and
 * text fields. Mobile Safari keeps the screen's left edge for its own back
 * gesture, so there a swipe starts a little way in.
 */

/** The sidebar's `w-64`. */
const WIDTH = 256;
/** Travel before the gesture commits to an axis. */
const LOCK = 10;
/** Share of the width past which a release opens the sidebar. */
const OPEN_AT = 0.35;
/** px/ms past which a release opens or shuts it whatever the distance. */
const FLICK = 0.4;
const DURATION = 200;
const PHONE = "(width < 48rem)";

function yieldsTo(target: EventTarget | null): boolean {
  for (let el = target as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    if (el.matches("input, textarea, select, [contenteditable='true']")) return true;
    const style = getComputedStyle(el);
    if (style.touchAction === "none") return true;
    const scrolls = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (scrolls && el.scrollLeft > 0) return true;
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
  useEffect(() => {
    if (disabled || typeof window.matchMedia !== "function") return;
    const phone = window.matchMedia(PHONE);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");

    let start: { x: number; y: number } | null = null;
    let axis: "x" | "y" | null = null;
    let progress = open ? 1 : 0;
    let last = { x: 0, t: 0 };
    let velocity = 0;

    // `translate`, not `transform`: the classes these elements carry at rest
    // are Tailwind translate utilities, which set the `translate` property, and
    // the two properties would compose rather than replace.
    const paint = (p: number, animate: boolean) => {
      const transition =
        animate && !still.matches
          ? `translate ${DURATION}ms ease-out, opacity ${DURATION}ms ease-out`
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
      if (frame.current) frame.current.style.overflowX = p > 0 ? "clip" : "";
    };
    // Hand the resting state back to the classes React renders.
    const release = () => {
      for (const el of [sidebar.current, page.current, scrim.current]) {
        if (!el) continue;
        el.style.transition = "";
        el.style.translate = "";
        el.style.opacity = "";
      }
      if (frame.current) frame.current.style.overflowX = "";
    };

    const onStart = (event: TouchEvent) => {
      start = null;
      if (!phone.matches || event.touches.length !== 1) return;
      if (!open && yieldsTo(event.target)) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY };
      last = { x: touch.clientX, t: event.timeStamp };
      axis = null;
      progress = open ? 1 : 0;
      velocity = 0;
    };

    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!axis) {
        if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
        // Sideways, and toward where the sidebar can go. Anything else is a
        // scroll, and the gesture lets it be one.
        const sideways = Math.abs(dx) > Math.abs(dy) * 1.5;
        axis = sideways && (open ? dx < 0 : dx > 0) ? "x" : "y";
        if (axis === "y") {
          start = null;
          return;
        }
      }
      event.preventDefault();
      velocity = (touch.clientX - last.x) / Math.max(event.timeStamp - last.t, 1);
      last = { x: touch.clientX, t: event.timeStamp };
      progress = Math.min(Math.max((open ? 1 : 0) + dx / WIDTH, 0), 1);
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
      window.setTimeout(
        () => {
          // Commit first, so the classes already say where the elements rest
          // when the inline styles come off. The other order shows the old
          // state for a frame.
          flushSync(() => setOpen(next));
          release();
        },
        still.matches ? 0 : DURATION,
      );
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [disabled, open, setOpen, sidebar, page, scrim, frame]);
}
