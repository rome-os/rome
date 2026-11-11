import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * A textarea's placeholder never shows an ellipsis where it overflows, so a
 * long name inside it is cut mid-letter. This shortens `name` with an ellipsis
 * until `build(name)` fits the textarea's width on one line, and measures
 * again when the textarea resizes. Without a canvas to measure on, or with no
 * name, it returns the whole text.
 */
export function useFittedPlaceholder(
  ref: RefObject<HTMLTextAreaElement | null>,
  name: string | null | undefined,
  build: (name: string) => string,
): string | null {
  const [fitted, setFitted] = useState<string | null>(null);
  const buildRef = useRef(build);
  buildRef.current = build;
  const full = name ? build(name) : null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !name) {
      setFitted(null);
      return;
    }
    const measure = () => {
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx || el.clientWidth === 0) return setFitted(null);
      const style = getComputedStyle(el);
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const make = buildRef.current;
      const fits = (text: string) => ctx.measureText(text).width <= room;
      if (fits(make(name))) return setFitted(null);
      let low = 0;
      let high = name.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(make(`${name.slice(0, mid).trimEnd()}…`))) low = mid;
        else high = mid - 1;
      }
      setFitted(make(`${name.slice(0, low).trimEnd()}…`));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, name, full]);

  return fitted ?? full;
}
