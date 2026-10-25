import { expect, test } from "@playwright/test";

/**
 * The guardian's row lists every account linked to them, and the mock guardian
 * holds a work email longer than a phone row. jsdom lays nothing out, so only a
 * browser can show that the row breaks that handle rather than clipping it.
 */
test.use({ viewport: { width: 390, height: 844 } });

test("the guardian's longest account handle fits inside the row on a phone", async ({ page }) => {
  await page.goto("/people");
  await page.getByRole("radio", { name: "Directory" }).click();
  const handle = page.getByText("guardian.work.account@example-company.com");
  await expect(handle).toBeVisible();

  const row = page.locator('[data-slot="list-row"]', { has: handle });
  const [handleBox, rowBox] = await Promise.all([handle.boundingBox(), row.boundingBox()]);
  expect(handleBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect(handleBox!.x + handleBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);

  // Clipped text is still laid out at full width inside its box, so the box
  // alone would pass a clipped handle. Its scroll width shows the difference.
  const clipped = await handle.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(clipped).toBe(false);
});
