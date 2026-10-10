import { expect, test } from "@playwright/test";

/**
 * Regression guard for rome-os/rome#383: mock mode used to reach the app
 * through a dynamic import, isolating it in an async chunk where React Fast
 * Refresh's $RefreshReg$ global was never established, so the page stayed
 * blank with "ReferenceError: $RefreshReg$ is not defined". The app must now
 * live on the main chunk (static import) and render only after the MSW worker
 * is ready. A blank body or any $RefreshReg$ runtime error fails here.
 */
test("mock mode renders the dashboard instead of a blank page", async ({ page }) => {
  const refreshErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (error.message.includes("$RefreshReg$")) {
      refreshErrors.push(error.message);
    }
  });

  await page.goto("/");
  // The app mounting is what the bug broke; the composer box is a stable
  // dashboard surface (same selector the composer geometry spec relies on).
  await expect(page.locator("[data-chat-composer-box]")).toBeVisible({
    timeout: 30_000,
  });
  expect(refreshErrors).toEqual([]);
});
