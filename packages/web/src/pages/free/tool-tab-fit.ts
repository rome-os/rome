/** Narrowest a tab shrinks to, in px, before the strip drops a tab instead. */
export const MIN_TAB_WIDTH = 128;
/** Space the strip leaves between two tabs, in px. */
export const TAB_GAP = 4;

/**
 * Returns the ids to draw in a strip `stripWidth` px wide, in `ids` order.
 *
 * Every tab is drawn while all of them fit at `MIN_TAB_WIDTH`. Otherwise the
 * strip keeps the leading tabs, and a hidden `activeId` takes the last slot so
 * the selected tab never leaves the strip. At least one tab is always drawn.
 * A null `stripWidth` means the strip is unmeasured, and every tab is drawn.
 *
 * fitTabs(["a", "b", "c"], "c", 270) returns ["a", "c"].
 */
export function fitTabs(ids: string[], activeId: string | null, stripWidth: number | null) {
  if (stripWidth === null) return ids;
  const capacity = Math.max(1, Math.floor((stripWidth + TAB_GAP) / (MIN_TAB_WIDTH + TAB_GAP)));
  if (ids.length <= capacity) return ids;
  const shown = ids.slice(0, capacity);
  if (activeId === null || shown.includes(activeId) || !ids.includes(activeId)) return shown;
  return [...shown.slice(0, -1), activeId];
}
