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
      const heading = page.getByRole("heading", { name: "Settings", exact: true });
      await expect(heading).toBeVisible();
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(
        page.locator('[data-slot="page-nav-link"][aria-current="page"]'),
      ).toHaveAttribute("href", `/settings/${tab}`);
      const body = page.locator('[data-slot="page"]').first();
      await expect(
        body
          .getByRole("combobox")
          .or(body.getByRole("button"))
          .or(body.getByRole("switch"))
          .first(),
      ).toBeVisible();
      if (tab === "channels") await expect(page.locator("main article").first()).toBeVisible();
      if (tab === "advanced") {
        await page.getByText("Developer Settings", { exact: true }).click();
        await expect(
          page.getByRole("switch", { name: "Route large models to Fable" }),
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
  test(`Settings detail routes retain navigation and contain wide content at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
    for (const [route, title] of [
      ["app-keys", "App keys"],
      ["github", "GitHub"],
    ]) {
      await page.goto(`/settings/connections/${route}`);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.locator("main h1")).toHaveCount(1);
      const back = page.locator("main").getByRole("link", { name: "Connections", exact: true });
      await expect(back).toHaveAttribute("href", "/settings/connections");
      expect(
        await page.locator('[data-slot="page"]').evaluate((el) => el.getBoundingClientRect().right),
      ).toBeLessThanOrEqual(width);
      if (route === "app-keys") {
        const scroll = page.locator('[data-slot="table-container"]');
        await expect(scroll).toBeVisible();
        expect(await scroll.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(
          width,
        );
      }
    }
  });
}
