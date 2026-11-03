import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Tracks whether a measured element is narrower than `threshold` px, using a
 * `ResizeObserver` on the element's own border-box.
 *
 * Unlike a `window`-based media query (e.g. the old `useIsBelowMd`), this keys
 * off the element's *own* width — so a panel embedded in a wider window still
 * collapses to its compact layout when the panel itself is narrow, independent
 * of the viewport. Attach the returned `ref` to the element to measure.
 *
 * Defaults to `false` (not-below) until the first measurement, which runs in a
 * layout effect before paint so the initial render lands without a flash.
 */
export function useContainerBelowWidth<T extends HTMLElement>(
  threshold: number,
): {
  ref: RefObject<T | null>;
  isBelow: boolean;
} {
  const ref = useRef<T | null>(null);
  const [isBelow, setIsBelow] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const update = (width: number) => {
      // A detached or `display:none` element measures 0; keep the last
      // layout. Flipping while hidden (e.g. an inactive workspace tab) would
      // swap the layout's subtree and lose state such as the folder a compact
      // file browser had drilled into.
      if (width > 0) setIsBelow(width < threshold);
    };

    update(element.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      update(width);
    });
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [threshold]);

  return { ref, isBelow };
}
