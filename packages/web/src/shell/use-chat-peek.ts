import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

/** A pointer this close to the window's left edge opens the peek at once. */
const PEEK_EDGE_PX = 4;
/** Resting on the Chat tile this long opens the peek, so a pointer that only
 *  crosses the rail on its way to another tile does not flash it open. */
export const PEEK_OPEN_DELAY_MS = 150;
/** Leaving the sidebar closes the peek after this long, so a pointer that
 *  overshoots the panel's edge by a few pixels can come back without losing it. */
export const PEEK_CLOSE_DELAY_MS = 200;

// Open layers only: the chat page keeps a closed trace drawer with
// role="dialog" in the DOM, so a bare role would hold the peek open for good.
const HOLDING_LAYERS =
  '[role="menu"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

interface ChatPeek {
  open: boolean;
  /** Pointer handlers for the rail's Chat tile. */
  tile: { onPointerEnter: () => void; onPointerLeave: () => void };
}

// With the chat list collapsed, the list can still be glanced at: hovering the
// Chat tile or pushing the pointer against the window's left edge shows it as
// a panel over the page, and moving past the panel hides it again. `enabled`
// is false whenever there is no collapsed list to show or no hover to show it
// by. `panel` is the peek itself; everything left of its right edge counts as
// inside.
export function useChatPeek(
  enabled: boolean,
  pathname: string,
  panel: RefObject<HTMLElement | null>,
): ChatPeek {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const schedule = useCallback((next: boolean, delay: number) => {
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setOpen(next);
    }, delay);
  }, []);

  // Opening a chat from the panel is the end of the glance.
  useEffect(() => {
    clear();
    setOpen(false);
  }, [pathname, clear]);

  useEffect(() => {
    if (enabled) return;
    clear();
    setOpen(false);
  }, [enabled, clear]);

  useEffect(() => clear, [clear]);

  useEffect(() => {
    if (!enabled) return;
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (!open) {
        if (event.clientX <= PEEK_EDGE_PX) {
          clear();
          setOpen(true);
        }
        return;
      }
      // Position, not pointerleave: a menu opened from a row sets
      // `pointer-events: none` on the body, which reads as leaving the
      // sidebar. An open menu or dialog, which only the panel can have opened
      // while it shows, holds it open wherever the pointer goes, since the
      // menu may hang past the panel's edge.
      const node = panel.current;
      const inside = node !== null && event.clientX <= node.getBoundingClientRect().right;
      const holding = document.querySelector(HOLDING_LAYERS) !== null;
      if (inside || holding) clear();
      else schedule(false, PEEK_CLOSE_DELAY_MS);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [enabled, open, clear, schedule, panel]);

  return {
    open: enabled && open,
    tile: {
      onPointerEnter: () => {
        if (enabled && !open) schedule(true, PEEK_OPEN_DELAY_MS);
      },
      // Only a pending open is cancelled here: once open, the panel stays
      // while the pointer is over the rail or the panel.
      onPointerLeave: () => {
        if (!open) clear();
      },
    },
  };
}
