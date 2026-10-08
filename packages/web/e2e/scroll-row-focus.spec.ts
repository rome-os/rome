import { expect, type Page, test } from "@playwright/test";

/**
 * A sideways-scrolling row (`PageNav`, `FilterChipGroup`) masks a 40px strip at
 * each clipped end and lays a chevron over it. Keyboard focus moved onto an
 * entry must scroll that entry clear of the strip, or the focused entry and its
 * outline sit under the mask. A browser scrolls a focused element only until it
 * is inside the scrollport, so this holds only through the rows' scroll padding.
 * jsdom lays nothing out, so only a browser can show it.
 */

const CLEARANCE = 40;

// Where the focused entry sits relative to the row's unmasked middle. Both
// numbers are >= 0 when the entry is clear of a masked end.
async function focusedClearance(page: Page, rowSelector: string) {
  return page.evaluate(
    ({ rowSelector, clearance }) => {
      const focused = document.activeElement;
      const row = focused?.closest(rowSelector);
      if (!focused || !row) return null;
      const r = row.getBoundingClientRect();
      const f = focused.getBoundingClientRect();
      const max = row.scrollWidth - row.clientWidth;
      const start = row.scrollLeft > 1 ? r.left + clearance : r.left;
      const end = row.scrollLeft < max - 1 ? r.right - clearance : r.right;
      return {
        label: focused.textContent?.trim(),
        start: Math.round(f.left - start),
        end: Math.round(end - f.right),
      };
    },
    { rowSelector, clearance: CLEARANCE },
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
});

test("tabbing through Settings keeps each focused tab clear of the masked ends", async ({
  page,
}) => {
  await page.goto("/settings/appearance");
  const links = page.locator('[data-slot="page-nav-link"]');
  await expect(links.first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await links.first().focus();
  const count = await links.count();
  for (let i = 1; i < count; i++) {
    await page.keyboard.press("Tab");
    const position = await focusedClearance(page, '[data-slot="page-nav"] ul');
    expect(position, `tab ${i}`).not.toBeNull();
    expect(position!.start, `${position!.label} start`).toBeGreaterThanOrEqual(0);
    expect(position!.end, `${position!.label} end`).toBeGreaterThanOrEqual(0);
  }
});

test("arrowing through Activity's filters keeps each focused chip clear of the masked ends", async ({
  page,
}) => {
  await page.goto("/activity");
  const chips = page.locator('[data-slot="filter-chip"]');
  await expect(chips.first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-slot="filter-chip"][data-state="checked"]').focus();
  const count = await chips.count();
  for (let i = 1; i < count; i++) {
    await page.keyboard.press("ArrowRight");
    const position = await focusedClearance(page, '[data-slot="filter-chip-group"]');
    expect(position, `arrow ${i}`).not.toBeNull();
    expect(position!.start, `${position!.label} start`).toBeGreaterThanOrEqual(0);
    expect(position!.end, `${position!.label} end`).toBeGreaterThanOrEqual(0);
  }
});
