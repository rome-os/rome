// Android draws the app edge-to-edge, so the window no longer shrinks when the
// keyboard opens: the WebView keeps its full height and the keyboard covers
// the chat composer. The shell pads the WebView by the part of it the keyboard
// covers. Measuring the overlap, instead of trusting the keyboard's reported
// height, also yields zero on a device that does resize the window.

/** Where a view sits in the window, in dp. */
export interface ViewFrame {
  y: number;
  height: number;
}

/**
 * The dp of `view` that a keyboard whose top edge sits at `keyboardTop` (window
 * coordinates, dp) covers. Zero when the keyboard ends above the view's bottom
 * edge or the view already ends at the keyboard.
 */
export function keyboardOverlap(view: ViewFrame, keyboardTop: number): number {
  return Math.max(0, Math.round(view.y + view.height - keyboardTop));
}
