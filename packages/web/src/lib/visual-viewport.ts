// Keeps the page sized to the part of the screen the person can see, so an
// open on-screen keyboard does not cover the chat composer.
//
// iOS Safari shrinks only the visual viewport when the keyboard opens.
// `100dvh` keeps the full height, so a page sized to it ends behind the
// keyboard, and Safari pans the whole page up to reveal the focused field.
// Publishing the visual viewport's height as `--rome-viewport-height` lets the
// shell end at the keyboard instead. Chrome on Android resizes the page itself,
// because index.html asks for `interactive-widget=resizes-content`, and this
// module reads that as an ordinary resize.

/** The CSS custom property on `<html>` that carries the usable height in px. */
export const VIEWPORT_HEIGHT_VAR = "--rome-viewport-height";

/**
 * The CSS custom property on `<html>` that carries, in px, how much of the
 * layout viewport's bottom the keyboard covers.
 */
export const KEYBOARD_HEIGHT_VAR = "--rome-keyboard-height";

/** The fields of `window.visualViewport` this module reads. */
export interface VisualViewportMetrics {
  height: number;
  pageTop: number;
  scale: number;
}

/**
 * The height to publish, or null to fall back to the stylesheet's `100dvh`.
 * Null while the page is pinch-zoomed: a zoomed visual viewport is smaller
 * than the screen, and sizing the layout to it would shrink the page under the
 * person's fingers.
 */
export function usableViewportHeight(viewport: VisualViewportMetrics): number | null {
  if (Math.abs(viewport.scale - 1) > 0.01) return null;
  return viewport.height;
}

/**
 * How far up from the layout viewport's bottom the keyboard reaches: the part
 * of `layoutHeight` below the visual viewport. Zero while the page is
 * pinch-zoomed, when the gap is the zoom and not a keyboard, and on Android,
 * where the keyboard shrinks the layout viewport along with the visual one.
 */
export function keyboardHeight(viewport: VisualViewportMetrics, layoutHeight: number): number {
  if (usableViewportHeight(viewport) === null) return 0;
  return Math.max(0, layoutHeight - viewport.height);
}

/**
 * The scroll position that brings the bottom of the visible area back to the
 * document's end, or null when nothing past the end shows. iOS keeps a page
 * panned up by the keyboard's height after the page itself shrank, or after
 * the keyboard closed, which leaves an empty band below the content.
 */
export function overscrollCorrection(
  viewport: VisualViewportMetrics,
  documentHeight: number,
): number | null {
  if (viewport.pageTop + viewport.height <= documentHeight + 1) return null;
  return Math.max(0, documentHeight - viewport.height);
}

/**
 * Publishes the usable height and the keyboard's height on `<html>` now and on
 * every visual viewport change, and scrolls back any band the page was panned past its end.
 * Returns a function that stops tracking. A no-op where the browser has no
 * `visualViewport`, which leaves the `100dvh` fallback in charge.
 */
export function trackVisualViewport(win: Window = window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const root = win.document.documentElement;

  const update = () => {
    const metrics = { height: viewport.height, pageTop: viewport.pageTop, scale: viewport.scale };
    const height = usableViewportHeight(metrics);
    if (height === null) root.style.removeProperty(VIEWPORT_HEIGHT_VAR);
    else root.style.setProperty(VIEWPORT_HEIGHT_VAR, `${height}px`);
    root.style.setProperty(KEYBOARD_HEIGHT_VAR, `${keyboardHeight(metrics, win.innerHeight)}px`);
    // The body, not <html>: the root's scrollHeight never drops below the
    // layout viewport, which iOS keeps at full height under the keyboard.
    // Reading it after the write lays the page out at the new height, so the
    // correction measures the page the person is about to see.
    const body = win.document.body;
    if (!body) return;
    const top = overscrollCorrection(metrics, body.scrollHeight);
    if (top !== null) win.scrollTo(0, top);
  };

  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
  };
}
