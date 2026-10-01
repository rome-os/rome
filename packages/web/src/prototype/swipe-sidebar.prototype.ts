// PROTOTYPE — variant D's navigation: swipe right anywhere to drag the sidebar
// out, the way the Claude mobile app reveals its chat list. The sidebar follows
// the finger, the page slides right with it under a dimming scrim, and on
// release it settles open or shut by distance and speed. Swiping left on the
// open sidebar or the dimmed page drags it back.
//
// A swipe yields to whatever already owns sideways movement where it starts:
// a sideways scroller not yet at its left edge (code blocks, tables, chip
// rows), anything with `touch-action: none` (the diagram's pan and zoom), and
// text fields.
import { type RefObject, useEffect } from "react";

const WIDTH = 256; // the sidebar's w-64
const LOCK = 10; // px of travel before the gesture picks an axis
const OPEN_AT = 0.35; // share of the width that opens it on release
const FLICK = 0.4; // px/ms that opens or shuts it regardless of distance

function yieldsTo(target: EventTarget | null): boolean {
  for (let el = target as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    if (el.closest("input, textarea, select, [contenteditable=true]")) return true;
    const style = getComputedStyle(el);
    if (style.touchAction === "none") return true;
    const scrolls = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (scrolls && el.scrollLeft > 0) return true;
  }
  return false;
}

export function useSwipeSidebar({
  enabled,
  open,
  setOpen,
  aside,
  page,
  scrim,
}: {
  enabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  aside: RefObject<HTMLElement | null>;
  page: RefObject<HTMLElement | null>;
  scrim: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number; t: number } | null = null;
    let axis: "x" | "y" | null = null;
    let progress = open ? 1 : 0;
    let last = { x: 0, t: 0 };
    let velocity = 0;

    // `translate`, not `transform`: Tailwind's translate-x utilities set the
    // `translate` property, and the two would compose rather than replace.
    const paint = (p: number, animate: boolean) => {
      const transition = animate ? "translate 200ms ease-out, opacity 200ms ease-out" : "none";
      if (aside.current) {
        aside.current.style.transition = transition;
        aside.current.style.translate = `${(p - 1) * 100}% 0`;
      }
      if (page.current) {
        page.current.style.transition = transition;
        page.current.style.translate = p > 0 ? `${p * WIDTH}px 0` : "";
      }
      if (scrim.current) {
        scrim.current.style.transition = transition;
        scrim.current.style.opacity = String(p);
      }
    };
    const release = () => {
      // Hand the resting state back to React's classes.
      for (const el of [aside.current, scrim.current]) {
        if (!el) continue;
        el.style.transition = "";
        el.style.translate = "";
        el.style.opacity = "";
      }
      if (page.current) page.current.style.transition = "";
    };

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!open && yieldsTo(event.target)) return;
      start = { x: touch.clientX, y: touch.clientY, t: event.timeStamp };
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
        // Sideways and toward the way the sidebar can move, or it is a scroll.
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
      window.setTimeout(() => {
        release();
        setOpen(next);
      }, 200);
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
  }, [enabled, open, setOpen, aside, page, scrim]);
}
