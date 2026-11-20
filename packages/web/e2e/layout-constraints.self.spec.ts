import { expect, type Page, test } from "@playwright/test";
import { checkConstraints, loadConstraints } from "./layout-constraints/check.js";

/**
 * The checker against seeded breaks on a real page. Uses the plain Playwright
 * `test`, not `./fixtures.js`, because each case leaves the page broken on
 * purpose and the end-of-test check would fail it again.
 */

const constraints = loadConstraints();
const ids = async (page: Page) =>
  (await checkConstraints(page, constraints)).map((f) => `${f.kind}:${f.id}`);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/chat/mock-chat-long-answers");
  await expect(page.getByText("Any time.").first()).toBeVisible({ timeout: 30_000 });
});

test("a sent bubble nudged 3px off the right edge is reported", async ({ page }) => {
  expect(await ids(page)).not.toContain("violation:sent-bubbles-share-right-edge");
  await page.evaluate(() => {
    const sent = [...document.querySelectorAll<HTMLElement>("[data-chat-bubble].bg-primary")];
    sent[1].style.marginRight = "3px";
  });
  expect(await ids(page)).toContain("violation:sent-bubbles-share-right-edge");
});

test("a 1px nudge stays inside the tolerance", async ({ page }) => {
  await page.evaluate(() => {
    const sent = [...document.querySelectorAll<HTMLElement>("[data-chat-bubble].bg-primary")];
    sent[1].style.marginRight = "1px";
  });
  expect(await ids(page)).not.toContain("violation:sent-bubbles-share-right-edge");
});

test("a locator that stops resolving marks the spec stale", async ({ page }) => {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-testid="message-row-name"]')) {
      el.removeAttribute("data-testid");
    }
  });
  expect(await ids(page)).toContain("stale:row-name-lines-up-with-bubble-text");
});
