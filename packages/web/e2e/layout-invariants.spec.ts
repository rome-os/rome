import { expect, test } from "@playwright/test";
import { collectButtonViolations, collectRowHeightViolations } from "./layout-invariants.js";

/**
 * Layout-invariant sweep over mock-mode routes.
 *
 * No snapshots and no pinned pixel values: every assertion is a relationship
 * (containment, centering, proportionality, uniformity) that any restyle
 * should still satisfy, so the suite is safe under active style
 * experimentation. Routes render against MSW fixtures (dev:mock), so the
 * geometry is deterministic.
 */

// Every route here is backed by MSW fixtures and renders at least one button,
// which is the readiness signal below. Mock mode returns empty collections for
// most endpoints, so the product routes are thin — the dev pages carry the
// control density (styleguide 48 visible controls, connections 31, typography
// 21) and are where a drifting primitive shows up first.
//
// Two routes are deliberately absent, and neither is "covered":
//   - /desktop renders no control at all, so it has nothing to measure.
//   - /dev/gallery reported a violation on one run and none on the next. The
//     suite runs with retries: 0 because a result that moves between runs is
//     itself the bug, so it stays out until that is diagnosed rather than
//     being allowed to flake here.
const ROUTES = [
  "/settings/appearance",
  "/settings/connections",
  "/settings/channels",
  "/settings/ai-tools",
  "/settings/favors",
  "/settings/advanced",
  "/chat",
  "/apps",
  "/apps/inbox",
  "/people",
  "/sessions",
  "/routines",
  "/activity",
  "/memory",
  "/projects",
  "/dev/styleguide",
  "/dev/typography",
  "/dev/connections",
  // Transcript blocks. Each renders only for a particular agent state, so this
  // route is the only place the sweep sees one at all.
  "/dev/chat-entries",
];

/** Mirrors the control slots `collectRowHeightViolations` compares. */
const MEASURED_CONTROLS = [
  "badge",
  "button",
  "icon-button",
  "input",
  "segmented-control",
  "select-trigger",
  "switch",
  "tabs-trigger",
  "textarea",
  "toggle",
]
  .map((slot) => `[data-slot="${slot}"]`)
  .join(",");

for (const route of ROUTES) {
  test(`controls on ${route} satisfy layout invariants`, async ({ page }) => {
    await page.goto(route);
    // Wait for real content rather than skeletons. The signal is any control
    // this sweep measures, not a Button specifically — /settings/appearance
    // and /settings/channels render none, and waiting on one there times out
    // against a page that is in fact fully rendered.
    //
    // `filter({ visible: true })` before `first()` is load-bearing: `first()`
    // picks the first DOM match whether or not it renders, so the shell's
    // hidden "Close sidebar" trigger would be chosen and then fail the
    // visibility assertion on every route. The sweep only measures visible
    // boxes, so the wait has to agree with it.
    // Generous first-paint budget: a cold rsbuild dev server compiles the
    // route's chunk on demand, which a shared runner does far slower than a
    // warm local machine. Only this wait is slow; the measurement after it is
    // instant.
    await expect(page.locator(MEASURED_CONTROLS).filter({ visible: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    // Text metrics move as webfonts swap in, and a CI runner resolves them
    // slower than a warm local machine — measuring mid-swap is the one way
    // these assertions could differ between runs.
    await page.evaluate(() => document.fonts.ready);

    const violations = [
      ...(await page.evaluate(collectButtonViolations)),
      ...(await page.evaluate(collectRowHeightViolations)),
    ];

    const report = violations
      .map((v) => `  [${v.invariant}] ${v.element}\n    ${v.detail}`)
      .join("\n");
    expect(violations, `layout invariant violations on ${route}:\n${report}`).toEqual([]);
  });
}
