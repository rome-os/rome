import { expect, test } from "@playwright/test";

const STORIES = [
  ["dev-previews-login--default", "input[type=password]"],
  ["dev-previews-onboarding--default", "#guardianName"],
  ["dev-previews-connections--default", "text=Connection dialog gallery"],
  ["dev-previews-chat-blocks--default", "text=Transcript blocks"],
  ["dev-previews-login--default", "input[type=password]"],
  ["dev-previews-onboarding--default", "#guardianName"],
] as const;

test("diagnostic previews switch without service requests", async ({ page }) => {
  const serviceRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    serviceRequests.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 500 });
  });

  for (const [storyId, readySelector] of STORIES) {
    await page.goto(`/iframe.html?id=${storyId}&viewMode=story`);
    await expect(page.locator(readySelector).first()).toBeVisible();
  }

  expect(serviceRequests).toEqual([]);
});
