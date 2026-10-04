import { expect, test } from "@playwright/test";

const tabs = ["appearance", "connections", "channels", "ai-tools", "favors", "advanced"];
const sectionTitles: Record<string, string> = {
  appearance: "Appearance",
  connections: "Connections",
  channels: "Channels",
  "ai-tools": "AI Tools",
  favors: "Favors",
  advanced: "Advanced",
};

for (const width of [390, 1440]) {
  test(`Settings keeps its header and controls inside the viewport at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
    let headerLeft: number | undefined;
    for (const tab of tabs) {
      await page.goto(`/settings/${tab}`);
      // On a phone a section is its own screen: it is titled by the section
      // and has a way back to the list of sections, instead of the strip.
      const phone = width < 768;
      const heading = page.locator("main h1");
      await expect(heading).toBeVisible();
      await expect(heading).toHaveAccessibleName(phone ? sectionTitles[tab] : "Settings");
      await expect(page.locator("main h1")).toHaveCount(1);
      if (phone) {
        await expect(
          page.locator("main").getByRole("link", { name: "Settings", exact: true }),
        ).toHaveAttribute("href", "/settings");
        await expect(page.locator('[data-slot="page-nav"]')).toBeHidden();
      } else {
        await expect(
          page.locator('[data-slot="page-nav-link"][aria-current="page"]'),
        ).toHaveAttribute("href", `/settings/${tab}`);
      }
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

test("bare /settings on a phone is the list of sections alone, and Appearance past 768px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
  // Only the Settings page asks for the tailnet devices (/api/settings has
  // other readers across the app), so this request marks a section's load.
  const sectionLoads: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/tailscale")) sectionLoads.push(pathname);
  });
  await page.goto("/settings");
  await expect(page.locator("main h1")).toHaveAccessibleName("Settings");
  await expect(
    page.locator("main nav").getByRole("link", { name: "Appearance", exact: true }),
  ).toHaveAttribute("href", "/settings/appearance");
  // The list names no section, mounts none and loads nothing a section reads.
  await expect(page).toHaveTitle(/^Settings · /);
  await page.waitForLoadState("networkidle");
  await expect(page.locator('[data-slot="form-row"]')).toHaveCount(0);
  expect(sectionLoads).toEqual([]);

  // Turning the phone, or widening the window, past 768px shows the page a
  // desktop gets at this URL.
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(page.locator('[data-slot="page-nav-link"][aria-current="page"]')).toHaveAttribute(
    "href",
    "/settings/appearance",
  );
});

test("the phone Settings back link replaces the section history entry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
  await page.goto("/settings");
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/connections$/);
  await page.locator("main").getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);

  // A contextual back action must not leave the section as the next browser
  // history entry; otherwise the browser's own back immediately reopens it.
  await page.goBack();
  await expect(page).toHaveURL(/\/settings$/);
});
