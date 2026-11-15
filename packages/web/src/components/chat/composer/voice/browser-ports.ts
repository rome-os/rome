// The browser side of the voice input ports. Not behaviors: these reach the
// DOM and React directly, so the behaviors do not have to.

import type { RefObject } from "react";
import { flushSync } from "react-dom";
import type { PageEvents } from "./field-presence";
import type { TextEditor } from "./spoken-insertion";

/** A controlled textarea as a `TextEditor`. `value` and `setValue` are the field's React state. */
export function textareaEditor(
  field: RefObject<HTMLTextAreaElement | null>,
  value: () => string,
  setValue: (next: string) => void,
): TextEditor {
  return {
    read() {
      const el = field.current;
      const current = value();
      return {
        value: current,
        start: el ? el.selectionStart : current.length,
        end: el ? el.selectionEnd : current.length,
      };
    },
    write(next) {
      // Rendered at once, so a native insert that follows lands on this
      // value. A field already unmounted has nothing to render.
      if (field.current) flushSync(() => setValue(next));
      else setValue(next);
    },
    select(start, end) {
      const el = field.current;
      if (!el) return false;
      el.focus();
      el.setSelectionRange(start, end);
      return document.activeElement === el;
    },
    insert(text) {
      // The browser inserts into the focused element, fires the input event
      // and records one undo step.
      return (
        typeof document.execCommand === "function" &&
        document.execCommand("insertText", false, text)
      );
    },
    whenShown(shown) {
      const el = field.current;
      if (!el || typeof ResizeObserver === "undefined") return () => {};
      const observer = new ResizeObserver(() => {
        if (el.getClientRects().length === 0) return;
        observer.disconnect();
        shown();
      });
      observer.observe(el);
      return () => observer.disconnect();
    },
  };
}

export const windowPage: PageEvents = {
  onHide(hidden) {
    window.addEventListener("pagehide", hidden);
    return () => window.removeEventListener("pagehide", hidden);
  },
};
