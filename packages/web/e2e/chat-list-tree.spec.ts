import { expect, test } from "./fixtures.js";

/**
 * A chat under a project folder hangs on the folder's guide line. The open
 * chat's mark sits centred on that line and on whole pixels, so neither edge
 * blurs at 1x.
 */
test.use({ viewport: { width: 1280, height: 900 } });

test("the open chat's mark is centred on its folder's guide", async ({ page }) => {
  await page.goto("/chat/mock-chat-build-app");
  const mark = page.locator("[data-tree-indicator]");
  await expect(mark).toHaveCount(1, { timeout: 30_000 });
  const guide = page.locator("[data-project-group]", { has: mark }).locator("[data-tree-guide]");
  const markBox = (await mark.boundingBox())!;
  const guideBox = (await guide.boundingBox())!;
  expect(markBox.x + markBox.width / 2).toBe(guideBox.x + guideBox.width / 2);
  expect(Number.isInteger(markBox.x)).toBe(true);
});
