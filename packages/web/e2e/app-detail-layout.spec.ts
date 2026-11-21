import { expect, test } from "@playwright/test";
import type { AppListResponse, InstalledAppCard } from "@rome/api-types/apps";

// A Store app with its source bundled, so the header offers all three actions:
// Open full view, Remix, and Open. That is the widest the action group gets.
const app: InstalledAppCard = {
  id: "layout-probe",
  displayName: "Layout Probe",
  description: "Checks that the details header fits a phone.",
  version: "1.0.0",
  status: "active",
  phase: "installed",
  hasFrontend: true,
  href: "/apps/layout-probe",
  fullHref: "/full/apps/layout-probe",
  capabilities: [],
  capabilityDetails: { agents: [], actions: [], skills: [], hooks: [] },
  isEnabled: true,
  canToggle: true,
  canUninstall: true,
  canPublish: false,
  accessMode: "private",
  isPublic: false,
  cloudAllowedEmails: [],
  canManagePublicAccess: false,
  source: { mode: "appstore", listingId: "layout-probe", version: "1.0.0" },
  projectPath: null,
  origin: "appstore",
  includeSource: true,
  iconUrl: null,
  installedAt: null,
};

for (const width of [320, 375]) {
  test(`app details header actions wrap inside the viewport at ${width}px`, async ({ page }) => {
    // The mock's service worker answers /api/apps itself, so a Playwright route
    // never sees the request. Answering it in the page, before the worker,
    // swaps in this one app and leaves every other fixture as it is.
    await page.addInitScript(
      (body) => {
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.pathname === "/api/apps") {
            return Promise.resolve(
              new Response(body, { headers: { "Content-Type": "application/json" } }),
            );
          }
          return original(input, init);
        };
      },
      JSON.stringify({ apps: [app] } satisfies AppListResponse),
    );
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
    await page.goto(`/app-details/${app.id}`);

    const actions = page.locator('[data-slot="page-actions"]');
    await expect(actions.getByRole("link", { name: "Open", exact: true })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Remix…" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const header = page.locator('[data-slot="page-header"]');
    const headerRight = await header.evaluate((el) => el.getBoundingClientRect().right);
    const controlRights = await actions
      .locator("a, button")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
    expect(controlRights).toHaveLength(3);
    for (const right of controlRights) expect(right).toBeLessThanOrEqual(headerRight + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  });
}
