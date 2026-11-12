import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** The name's characters as a reader sees them: one emoji or flag is one. */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/**
 * A textarea's placeholder never shows an ellipsis where it overflows, so a
 * long name inside it is cut mid-letter. This shortens `name` with an ellipsis
 * until `build(name)` fits the textarea's width on one line, and measures
 * again when the textarea resizes or a web font finishes loading. It cuts
 * between whole characters (grapheme clusters), so an emoji is never split. Without a canvas to measure on, or with no
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
      const chars = graphemes(name);
      const cut = (count: number) => `${chars.slice(0, count).join("").trimEnd()}…`;
      let low = 0;
      let high = chars.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(make(cut(mid)))) low = mid;
        else high = mid - 1;
      }
      setFitted(make(cut(low)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // A web font that swaps in changes the text's width without resizing the
    // textarea, so measure again once the fonts are in.
    const fonts = document.fonts;
    let live = true;
    void fonts?.ready.then(() => {
      if (live) measure();
    });
    fonts?.addEventListener("loadingdone", measure);
    return () => {
      live = false;
      fonts?.removeEventListener("loadingdone", measure);
      observer.disconnect();
    };
  }, [ref, name, full]);

  return fitted ?? full;
}
