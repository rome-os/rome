import { useEffect, useRef, useState } from "react";
import { findScrollableYAncestor } from "@/lib/scroll-container";

/**
 * Calls `onReached` when the end of a list scrolls into view, so the list can
 * show more rows. Put the returned `ref` on an element after the last row.
 *
 * The end is watched while `enabled` holds. Each new `page` watches it again,
 * so an end still in view after a page lands asks for the next one.
 * `rootMargin` reaches past the scroller's edge, so a page lands before the
 * last row does. `findRoot` picks that scroller, the nearest one that scrolls
 * vertically by default.
 */
export function useListEnd({
  enabled,
  page,
  onReached,
  rootMargin,
  findRoot = (end) => findScrollableYAncestor(end),
}: {
  enabled: boolean;
  page: number;
  onReached: () => void;
  rootMargin: string;
  findRoot?: (end: HTMLElement) => Element | null;
}): { ref: (end: HTMLElement | null) => void } {
  const [end, setEnd] = useState<HTMLElement | null>(null);
  const onReachedRef = useRef(onReached);
  onReachedRef.current = onReached;
  const findRootRef = useRef(findRoot);
  findRootRef.current = findRoot;

  // `page` is a dependency only so that each new page starts a fresh watch.
  useEffect(() => {
    if (!enabled || !end || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReachedRef.current();
      },
      { root: findRootRef.current(end), rootMargin },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [enabled, end, page, rootMargin]);

  return { ref: setEnd };
}
