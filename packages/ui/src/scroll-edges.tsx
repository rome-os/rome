import {
  type CSSProperties,
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useState,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./cn.js";

/** Which ends of a sideways-scrolling row have content past the visible edge. */
export interface ScrollEdges {
  start: boolean;
  end: boolean;
}

/**
 * Width of each masked end, in px: the outer 16px under the chevron is fully
 * clear, so no half-shown item sits behind it, then the row fades in over the
 * next 24px. An entry brought into view keeps this far from a masked end.
 */
const EDGE_CLEARANCE = 40;
const CLEAR = 16;

/**
 * Scrolls `row` just far enough to bring `item` clear of a masked end. Moves
 * only the row's scrollLeft: scrollIntoView would also scroll the page.
 */
export function revealInRow(row: HTMLElement, item: Element) {
  const bounds = row.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  if (rect.right > bounds.right - EDGE_CLEARANCE) {
    row.scrollLeft += rect.right - bounds.right + EDGE_CLEARANCE;
  } else if (rect.left < bounds.left + EDGE_CLEARANCE) {
    row.scrollLeft -= bounds.left + EDGE_CLEARANCE - rect.left;
  }
}

/**
 * Tracks which ends of `ref`'s row hide content. Mobile browsers draw no
 * scrollbar, so without a cue a row clipped between two items reads as
 * complete. Re-measures on scroll, on resize, and after every render, since new
 * content widens the row without resizing its box.
 *
 * Also reveals whatever takes keyboard focus inside the row. A browser scrolls a
 * focused element only until it is inside the row, which can leave it under the
 * mask. Pointer focus is left alone: it lands on press, and scrolling then
 * would move the target out from under the release, so the click misses.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false });

  const update = useCallback(() => {
    const row = ref.current;
    if (!row) return;
    const max = Math.max(row.scrollWidth - row.clientWidth, 0);
    const next = { start: row.scrollLeft > 1, end: row.scrollLeft < max - 1 };
    setEdges((current) =>
      current.start === next.start && current.end === next.end ? current : next,
    );
  }, [ref]);

  useEffect(() => {
    update();
  });

  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(row);
    const reveal = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && target.matches(":focus-visible")) revealInRow(row, target);
    };
    row.addEventListener("scroll", update, { passive: true });
    row.addEventListener("focusin", reveal);
    return () => {
      observer?.disconnect();
      row.removeEventListener("scroll", update);
      row.removeEventListener("focusin", reveal);
    };
  }, [ref, update]);

  return edges;
}

/** Fades the row out toward each end that hides content, and only those ends. */
export function scrollEdgeMask(edges: ScrollEdges): CSSProperties | undefined {
  if (!edges.start && !edges.end) return undefined;
  const start = edges.start
    ? `transparent 0, transparent ${CLEAR}px, black ${EDGE_CLEARANCE}px`
    : "black 0";
  const end = edges.end
    ? `black calc(100% - ${EDGE_CLEARANCE}px), transparent calc(100% - ${CLEAR}px), transparent 100%`
    : "black 100%";
  const mask = `linear-gradient(to right, ${start}, ${end})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

// A click would focus the button, which is hidden from assistive tech and
// unmounts once its end is reached, dropping focus to the body.
const keepFocus = (event: MouseEvent) => event.preventDefault();

const SCROLL_BUTTON_CLASS =
  "absolute inset-y-0 flex w-8 items-center text-muted-foreground hover:text-foreground [&_svg]:size-4";

/**
 * A chevron on each clipped end that scrolls the row most of a width. The fade
 * alone is not enough: a clip that falls in the gap between two items, or
 * shows only a sliver of one, fades to nothing and the row looks complete.
 * Renders into the row's positioned frame.
 *
 * Pointer-only: a keyboard user tabs through the items, which scrolls the row,
 * so the chevrons stay out of the tab order and the accessibility tree, and a
 * click does not move focus onto them.
 */
export function ScrollEdgeButtons({
  edges,
  rowRef,
}: {
  edges: ScrollEdges;
  rowRef: RefObject<HTMLElement | null>;
}) {
  const scrollBy = (direction: 1 | -1) => {
    const row = rowRef.current;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row?.scrollBy({
      left: direction * row.clientWidth * 0.75,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };
  return (
    <>
      {edges.start ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          data-slot="scroll-edge-button"
          onMouseDown={keepFocus}
          onClick={() => scrollBy(-1)}
          className={cn(SCROLL_BUTTON_CLASS, "left-0 justify-start")}
        >
          <ChevronLeft />
        </button>
      ) : null}
      {edges.end ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          data-slot="scroll-edge-button"
          onMouseDown={keepFocus}
          onClick={() => scrollBy(1)}
          className={cn(SCROLL_BUTTON_CLASS, "right-0 justify-end")}
        >
          <ChevronRight />
        </button>
      ) : null}
    </>
  );
}
