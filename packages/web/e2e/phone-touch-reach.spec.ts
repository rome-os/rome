import { expect, test, type Page } from "@playwright/test";
import {
  collectTouchReachViolations,
  measureHorizontalOverflow,
  type ReachViolation,
} from "./touch-reach.js";

/**
 * The dashboard on a phone: every control reachable by a 44px fingertip, and
 * no page scrolling sideways. A 390x844 touch screen with no hover, which is
 * an iPhone's portrait viewport and the media `touch-hit`, `touch-target` and
 * `touch-row` key on.
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

    const violations = await page.evaluate(collectTouchReachViolations, null);
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

  const violations = await page.evaluate(collectTouchReachViolations, "aside");
  expect(violations, `controls under 44px reach in the sidebar:\n${report(violations)}`).toEqual(
    [],
  );
});
