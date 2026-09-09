import { expect, test } from "@playwright/test";

function watchServiceRequests(page: import("@playwright/test").Page) {
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const requests: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin || url.pathname.startsWith("/api/")) requests.push(url.href);
  });

  return requests;
}

test("network-free stories stay isolated and issue no service requests", async ({ page }) => {
  const requests = watchServiceRequests(page);

  await page.goto("/iframe.html?id=dev-chat-blocks--compact-question&viewMode=story");
  const warm = page.getByRole("button", { name: "Warm" });
  await expect(warm).toHaveAttribute("aria-pressed", "false");
  await warm.focus();
  await page.keyboard.press("Enter");
  await expect(warm).toHaveAttribute("aria-pressed", "true");

  await page.goto("/iframe.html?id=dev-chat-blocks--resolved-question&viewMode=story");
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);

  await page.goto("/iframe.html?id=dev-connections-slot-card--not-connected&viewMode=story");
  await expect(page.getByText("Your GitHub account", { exact: true })).toBeVisible();

  await page.goto("/iframe.html?id=dev-chat-blocks--compact-question&viewMode=story");
  await expect(page.getByRole("button", { name: "Warm" })).toHaveAttribute("aria-pressed", "false");

  expect(requests).toEqual([]);
});
