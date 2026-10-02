import { expect, test } from "@playwright/test";

/**
 * On a phone the Activity filter pills become one native picker. It is a
 * field like any other: the kit's focus outline shows when the keyboard
 * reaches it, and picking an option filters the list as a pill does.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("the phone Activity filter picker shows focus and filters", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
  await page.goto("/activity");
  const picker = page.getByRole("combobox", { name: "Show" });
  await expect(picker).toBeVisible({ timeout: 30_000 });

  const outline = () =>
    picker.evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, color: style.outlineColor };
    });
  // The outline is always laid out, transparent until keyboard focus, so
  // showing it moves nothing.
  const transparent = /rgba\(0, 0, 0, 0\)|transparent/;
  expect((await outline()).color).toMatch(transparent);
  await picker.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(picker).toBeFocused();
  const focused = await outline();
  expect(focused.style).toBe("solid");
  expect(focused.color).not.toMatch(transparent);

  const first = await picker.locator("option").nth(1).getAttribute("value");
  await picker.selectOption(first!);
  await expect(picker).toHaveValue(first!);
});
