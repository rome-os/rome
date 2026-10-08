import { type CSSProperties, type RefObject, useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./cn.js";

/** Which ends of a sideways-scrolling row have content past the visible edge. */
export interface ScrollEdges {
  start: boolean;
  end: boolean;
}

// The outer 16px under each chevron is fully clear, then the row fades in over
// the next 24px, so no half-shown item sits behind the chevron.
const CLEAR = "16px";
const FADE_END = "40px";

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

/** Fades the row out toward each end that hides content, and only those ends. */
export function scrollEdgeMask(edges: ScrollEdges): CSSProperties | undefined {
  if (!edges.start && !edges.end) return undefined;
  const start = edges.start ? `transparent 0, transparent ${CLEAR}, black ${FADE_END}` : "black 0";
  const end = edges.end
    ? `black calc(100% - ${FADE_END}), transparent calc(100% - ${CLEAR}), transparent 100%`
    : "black 100%";
  const mask = `linear-gradient(to right, ${start}, ${end})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

const SCROLL_BUTTON_CLASS =
  "absolute inset-y-0 flex w-8 items-center text-muted-foreground hover:text-foreground [&_svg]:size-4";

/**
 * A chevron on each clipped end that scrolls the row most of a width. The fade
 * alone is not enough: a clip that falls in the gap between two items, or
 * shows only a sliver of one, fades to nothing and the row looks complete.
 * Renders into the row's positioned frame.
 *
 * Pointer-only: a keyboard user tabs through the items, which scrolls the row,
 * so the chevrons stay out of the tab order and the accessibility tree.
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
          onClick={() => scrollBy(1)}
          className={cn(SCROLL_BUTTON_CLASS, "right-0 justify-end")}
        >
          <ChevronRight />
        </button>
      ) : null}
    </>
  );
}
