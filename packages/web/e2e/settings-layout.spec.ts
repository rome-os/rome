import { expect, test } from "@playwright/test";

const tabs = ["appearance", "connections", "channels", "ai-tools", "favors", "advanced"];

for (const width of [390, 1440]) {
  test(`Settings keeps its header and controls inside the viewport at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
    let headerLeft: number | undefined;
    for (const tab of tabs) {
      await page.goto(`/settings/${tab}`);
      const dialog = page.getByRole("dialog", { name: "Settings" });
      const heading = dialog.getByRole("heading", { name: "Settings", exact: true });
      await expect(heading).toBeVisible();
      await expect(dialog.locator('nav a[aria-current="page"]')).toHaveAttribute(
        "href",
        `/settings/${tab}`,
      );
      const body = dialog.locator('[data-slot="page"]').first();
      await expect(
        body
          .getByRole("combobox")
          .or(body.getByRole("button"))
          .or(body.getByRole("switch"))
          .first(),
      ).toBeVisible();
      if (tab === "channels") await expect(dialog.locator("article").first()).toBeVisible();
      if (tab === "advanced") {
        // Developer settings is always open, so its switches show without a click.
        await expect(
          page.getByRole("switch", { name: "Enable model selector in chat" }),
        ).toBeVisible();
      }
      await page.evaluate(() => document.fonts.ready);
      const x = (await heading.boundingBox())!.x;
      headerLeft ??= x;
      expect(x).toBe(headerLeft);
      const overflowing = await page
        .locator('[data-slot="form-row"]')
        .evaluateAll((rows) =>
          rows.filter((row) => row.scrollWidth > row.clientWidth + 1).map((row) => row.textContent),
        );
      expect(overflowing).toEqual([]);
      expect(await body.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(
        width,
      );
    }
  });
}

for (const width of [390, 1440]) {
  test(`Settings detail routes keep a way back and contain wide content at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
    await page.goto("/settings/connections/github");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("heading", { name: "GitHub", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Connections", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/connections$/);
    await page.goBack();
    expect(
      await dialog.locator('[data-slot="page"]').evaluate((el) => el.getBoundingClientRect().right),
    ).toBeLessThanOrEqual(width);
  });
}

test("A Connections card opens its detail inside Settings, and Escape returns to the card", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
  await page.goto("/settings/connections");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const card = dialog.getByRole("button", { name: "Open GitHub" });
  await card.click();
  await expect(dialog.getByRole("dialog", { name: "GitHub" })).toBeVisible();
  await expect(dialog.getByLabel("Search connections")).toBeHidden();
  // Settings is the only modal: no dialog sits outside it.
  const outside = await dialog.evaluate(
    (settings) =>
      [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(
        (other) => other !== settings && !settings.contains(other),
      ).length,
  );
  expect(outside).toBe(0);
  await page.keyboard.press("Escape");
  await expect(card).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/connections$/);
});
