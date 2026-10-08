import { type MouseEvent, type RefObject, useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./cn.js";

/** Which ends of a sideways-scrolling row have content past the visible edge. */
export interface ScrollEdges {
  start: boolean;
  end: boolean;
}

/** Width of a chevron, in px. An entry brought into view keeps this far from the row's ends. */
const CHEVRON_WIDTH = 32;

/**
 * Scrolls `row` just far enough to bring `item` clear of a chevron. Moves only
 * the row's scrollLeft: scrollIntoView would also scroll the page.
 */
export function revealInRow(row: HTMLElement, item: Element) {
  const bounds = row.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  if (rect.right > bounds.right - CHEVRON_WIDTH) {
    row.scrollLeft += rect.right - bounds.right + CHEVRON_WIDTH;
  } else if (rect.left < bounds.left + CHEVRON_WIDTH) {
    row.scrollLeft -= bounds.left + CHEVRON_WIDTH - rect.left;
  }
}

/**
 * Tracks which ends of `ref`'s row hide content. Mobile browsers draw no
 * scrollbar, so without a cue a row clipped between two items reads as
 * complete. Re-measures on scroll, on resize, and after every render, since new
 * content widens the row without resizing its box.
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
    row.addEventListener("scroll", update, { passive: true });
    return () => {
      observer?.disconnect();
      row.removeEventListener("scroll", update);
    };
  }, [ref, update]);

  return edges;
}

// A click would focus the button, which is hidden from assistive tech and
// unmounts once its end is reached, dropping focus to the body.
const keepFocus = (event: MouseEvent) => event.preventDefault();

// Solid behind the chevron, so a half-shown item under it does not read as
// overlapping text. Stops 1px short of the bottom to leave a row's border line.
const SCROLL_BUTTON_CLASS =
  "absolute top-0 bottom-px flex w-8 items-center bg-background text-muted-foreground hover:text-foreground [&_svg]:size-4";

/**
 * A chevron on each clipped end that scrolls the row most of a width. Renders
 * into the row's positioned frame.
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
    row?.scrollBy({ left: direction * row.clientWidth * 0.75, behavior: "smooth" });
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
