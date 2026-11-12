/**
 * How the composer's floor stacks and takes presses. With no thread view open
 * it paints the canvas below md and takes presses there, so a tap beside the
 * composer cannot land on a link it hides. Over an open thread view it has no
 * canvas, and only the composer takes presses: a press beside it goes through
 * to the view and closes it, at every width.
 */
export function chatFloorLayering(threadOpen: boolean): string {
  return threadOpen ? "z-30" : "z-10 max-md:pointer-events-auto max-md:bg-chat-canvas";
}
