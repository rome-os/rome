import { expect, test, type Page } from "@playwright/test";
import {
  collectTouchReachViolations,
  measureHorizontalOverflow,
  type ReachViolation,
} from "./touch-reach.js";

/**
 * The dashboard on a phone: every control reachable by a 44px fingertip, and
 * no page scrolling sideways. A 390x844 touch screen, an iPhone's portrait
 * viewport, where the kit's phone scale paints every control at 44px
 * (DESIGN.md, Layout).
 *
 * The routes are the ones the phone survey measured. The chat transcript is
 * the one that carries message actions and a Mermaid fence; /apps/inbox is
 * where a timestamp used to push the page 4px wide.
 */
test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

const ROUTES: { path: string; ready?: string }[] = [
  {
    path: "/chat/mock-chat-build-app",
    // The fence renders its diagram, and with it the zoom stack, after mount.
    ready: '[data-streamdown="mermaid"] button[title="Zoom in"]',
  },
  { path: "/chat" },
  { path: "/activity" },
  { path: "/people/latest" },
  { path: "/memory" },
  { path: "/projects" },
  { path: "/sessions" },
  { path: "/routines" },
  { path: "/apps" },
  { path: "/apps/inbox" },
  { path: "/settings" },
  { path: "/settings/connections" },
  { path: "/desktop" },
];

async function settle(page: Page, ready?: string) {
  // Generous first-paint budget: a cold rsbuild dev server compiles each
  // route's chunk on demand.
  await expect(page.locator('header[data-app-titlebar="header"]')).toBeVisible({
    timeout: 30_000,
  });
  if (ready) await expect(page.locator(ready).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

function report(violations: ReachViolation[]): string {
  return violations.map((v) => `  ${v.element}\n    ${v.misses.join("\n    ")}`).join("\n");
}

test("the emulated device has touch and no hover", async ({ page }) => {
  await page.goto("/chat");
  // Every rule under test keys on this. If emulation stopped producing it,
  // every case below would measure the desktop layout and pass vacuously.
  expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
});

for (const { path, ready } of ROUTES) {
  test(`${path} at phone size: 44px reach, no sideways scroll`, async ({ page }) => {
    await page.goto(path);
    await settle(page, ready);

    expect(await page.evaluate(measureHorizontalOverflow), `${path} scrolls sideways`).toBe(0);

    const violations = await page.evaluate(collectTouchReachViolations, {
      scope: null,
      ownBox: false,
      reach: true,
    });
    expect(violations, `controls under 44px reach on ${path}:\n${report(violations)}`).toEqual([]);
  });
}

test("the open sidebar at phone size: 44px reach", async ({ page }) => {
  await page.goto("/chat");
  await settle(page);
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const sidebar = page.locator("aside");
  // The slide-over animates in; measure it at rest.
  await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);

  const violations = await page.evaluate(collectTouchReachViolations, {
    scope: "aside",
    ownBox: false,
    reach: true,
  });
  expect(violations, `controls under 44px reach in the sidebar:\n${report(violations)}`).toEqual(
    [],
  );
});

// The rule a hit area reaching past its box would break, held on every route
// mock mode serves rather than only the surveyed ones: a tap on a control's
// own box reaches that control, not a neighbour whose hit area spills over it.
// A phone paints controls at 44px instead of extending them, so this holds by
// construction, and the check keeps it that way. These
// pages are not all laid out for a phone, so they are not held to the 44px
// reach. /dev/gallery carries the kit's composites, such as Calendar's day
// grid, ButtonGroup and a packed icon toolbar, which pack controls closest.
const EVERY_ROUTE = [
  ...ROUTES.map(({ path }) => path),
  "/people/directory",
  "/people/person/wei-chen",
  "/sessions/all",
  "/routines/routine-brief",
  "/app-details/weather",
  "/settings/appearance",
  "/settings/devices",
  "/settings/channels",
  "/settings/ai-tools",
  "/settings/favors",
  "/settings/advanced",
  "/settings/connections/github",
  "/settings/connections/app-keys",
  "/events",
  "/guide",
  "/dev/gallery",
  "/dev/styleguide",
  "/dev/chat-blocks",
  "/dev/connections",
];

for (const path of EVERY_ROUTE) {
  test(`${path} at phone size: every control's own box is its own`, async ({ page }) => {
    await page.goto(path);
    // Some /dev pages render outside the shell, so the readiness signal is
    // any control at all rather than the shell's header.
    await expect(page.locator("button").filter({ visible: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    if (path === "/dev/gallery") {
      await expect(page.locator("#calendar [data-day]").first()).toBeVisible({ timeout: 30_000 });
    }
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);

    const violations = await page.evaluate(collectTouchReachViolations, {
      scope: null,
      ownBox: true,
      reach: false,
    });
    expect(
      violations,
      `taps on a control's own box that land elsewhere on ${path}:\n${report(violations)}`,
    ).toEqual([]);
  });
}
