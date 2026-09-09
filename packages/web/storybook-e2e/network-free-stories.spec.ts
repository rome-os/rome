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

  await page.goto("/iframe.html?id=dev-connections-channel-status--not-connected&viewMode=story");
  await expect(page.getByRole("heading", { name: "Discord" })).toBeVisible();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  await expect(
    page.getByText("This connection will let your agent", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();

  await page.goto("/iframe.html?id=dev-connections-channel-status--connected&viewMode=story");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByText("This connection lets your agent", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();

  await page.goto("/iframe.html?id=dev-chat-blocks--compact-question&viewMode=story");
  await expect(page.getByRole("button", { name: "Warm" })).toHaveAttribute("aria-pressed", "false");

  expect(requests).toEqual([]);
});
