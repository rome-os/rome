import type { MouseEvent } from "react";

/**
 * Whether a click on a link is a plain one, which the page may handle in
 * place. A click with a modifier or another button keeps the browser's own
 * meaning: a new tab, a new window, a download.
 */
export function isPlainClick(event: MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
