/** How far below the transcript's top edge a collapsed bubble's top is put when it was scrolled out of view: one 16px spacing step. */
export const COLLAPSE_SNAP_OFFSET = 16;

/**
 * The scrollTop that keeps a bubble in place across a toggle. `before` and
 * `after` are the bubble's top before the toggle and now, measured with
 * `getBoundingClientRect().top`; `viewportTop` is the scroller's own top edge.
 *
 * The bubble's top goes back to where it was. The one exception is a bubble
 * that is closing with its top scrolled above the viewport: the reader was
 * deep inside it, and the shortened bubble would end up far above them, so its
 * top is brought to {@link COLLAPSE_SNAP_OFFSET} below the viewport's top.
 */
export function scrollTopAfterToggle(input: {
  scrollTop: number;
  before: number;
  after: number;
  viewportTop: number;
  collapsing: boolean;
}): number {
  const { scrollTop, before, after, viewportTop, collapsing } = input;
  const target = collapsing && before < viewportTop ? viewportTop + COLLAPSE_SNAP_OFFSET : before;
  return scrollTop + (after - target);
}
