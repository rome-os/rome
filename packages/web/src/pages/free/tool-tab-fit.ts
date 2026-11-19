/**
 * The width a tab is taken to have before it is measured, in px: a short
 * name such as "Outputs" and its close button. Tabs hug their names, so a
 * measured width replaces it as soon as there is one.
 */
export const MIN_TAB_WIDTH = 96;
/** Space the strip leaves between two tabs, in px. */
export const TAB_GAP = 4;

/**
 * Returns the ids to draw in a strip `stripWidth` px wide, in `ids` order.
 *
 * Each tab takes its own width, `widthOf(id)`; one not measured yet (0)
 * counts as `MIN_TAB_WIDTH`. The strip keeps the leading tabs that fit, and
 * a hidden `activeId` takes the place of as many trailing ones as it needs,
 * so the selected tab never leaves the strip. At least one tab is always
 * drawn. A null `stripWidth` means the strip is unmeasured, and every tab is
 * drawn.
 *
 * fitTabs(["a", "b", "c"], "c", 270) returns ["a", "c"] for 96 px tabs.
 */
export function fitTabs(
  ids: string[],
  activeId: string | null,
  stripWidth: number | null,
  widthOf: (id: string) => number = () => 0,
) {
  if (stripWidth === null) return ids;
  const width = (id: string) => widthOf(id) || MIN_TAB_WIDTH;
  const total = (tabs: string[]) =>
    tabs.reduce((sum, id) => sum + width(id), 0) + Math.max(0, tabs.length - 1) * TAB_GAP;
  if (total(ids) <= stripWidth) return ids;
  const shown: string[] = [];
  for (const id of ids) {
    if (total([...shown, id]) > stripWidth) break;
    shown.push(id);
  }
  if (activeId === null || !ids.includes(activeId) || shown.includes(activeId)) {
    return shown.length > 0 ? shown : ids.slice(0, 1);
  }
  // The selected tab takes the place of trailing ones until it fits.
  while (shown.length > 0 && total([...shown, activeId]) > stripWidth) shown.pop();
  return [...shown, activeId];
}
