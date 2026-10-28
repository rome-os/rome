import { expect, type Page, test } from "@playwright/test";

/**
 * The rail names its tiles until the guardian hides the names. A click on its
 * edge or a drag across it switches between the two widths, and the choice
 * holds across reloads. On a phone the drawer is the rail alone, named until
 * its button hides the names, and the chat list is a screen over the chat that
 * the header's back button opens.
 */
const railWidth = (page: Page) =>
  page.evaluate(() =>
    Math.round(document.querySelector("aside > div")!.getBoundingClientRect().width),
  );

const iconCenter = (page: Page, href: string) =>
  page.evaluate((href) => {
    const box = document.querySelector(`aside a[href="${href}"] svg`)!.getBoundingClientRect();
    return Math.round(box.left + box.width / 2);
  }, href);

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("names show by default, and the edge hides and shows them without moving an icon", async ({
    page,
  }) => {
    await page.goto("/memory");
    const apps = page.locator('aside a[href="/apps"]');
    await expect(apps).toHaveText("Apps", { timeout: 30_000 });
    expect(await railWidth(page)).toBe(192);
    const named = await iconCenter(page, "/apps");

    const edge = (await page.locator("[data-rail-edge]").boundingBox())!;
    const x = edge.x + edge.width / 2;
    await page.mouse.click(x, 400);
    await expect.poll(() => railWidth(page)).toBe(64);
    await expect(apps).toHaveText("");
    expect(await iconCenter(page, "/apps")).toBe(named);

    // A drag snaps to the other width once it has travelled far enough.
    const bare = (await page.locator("[data-rail-edge]").boundingBox())!;
    await page.mouse.move(bare.x + bare.width / 2, 400);
    await page.mouse.down();
    await page.mouse.move(bare.x + bare.width / 2 + 12, 400, { steps: 3 });
    expect(await railWidth(page)).toBe(64);
    await page.mouse.move(bare.x + bare.width / 2 + 60, 400, { steps: 3 });
    await page.mouse.up();
    await expect.poll(() => railWidth(page)).toBe(192);

    await page.getByRole("button", { name: "Hide names", exact: true }).click();
    await page.reload();
    await expect(apps).toBeVisible({ timeout: 30_000 });
    expect(await railWidth(page)).toBe(64);
  });

  test("the Chat tile stays lit on an open chat", async ({ page }) => {
    await page.goto("/chat/mock-chat-build-app");
    await expect(page.locator('aside nav a[href="/chat"]')).toHaveClass(/shadow-1/, {
      timeout: 30_000,
    });
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the drawer is the rail, and back opens the chat list over the chat", async ({ page }) => {
    await page.goto("/chat/mock-chat-build-app");
    const header = page.locator("header[data-mobile-header]");
    await expect(header).toBeVisible({ timeout: 30_000 });

    // Back comes first, then the menu.
    const labels = await header
      .getByRole("button")
      .evaluateAll((buttons) => buttons.slice(0, 2).map((b) => b.getAttribute("aria-label")));
    expect(labels).toEqual(["Chat list", "Open sidebar"]);

    await header.getByRole("button", { name: "Open sidebar", exact: true }).click();
    await expect(page.locator('aside a[href="/apps"]')).toHaveText("Apps");
    expect(await railWidth(page)).toBe(192);
    await page.keyboard.press("Escape");

    await header.getByRole("button", { name: "Chat list", exact: true }).click();
    const list = page.locator("[data-phone-chat-list]");
    await expect(list).toBeVisible();
    await list.locator('a[href^="/chat/"]').nth(1).click();
    await expect(list).toHaveCount(0);
    await expect(page).toHaveURL(/\/chat\/(?!mock-chat-build-app)/);

    // New chat on the list closes it too, though the path may not change.
    await header.getByRole("button", { name: "Chat list", exact: true }).click();
    await list.getByRole("link", { name: "New chat", exact: true }).click();
    await expect(list).toHaveCount(0);
    await expect(page).toHaveURL(/\/chat$/);
  });

  test("the drawer's button hides the names, and the page is pushed by the bare rail", async ({
    page,
  }) => {
    await page.goto("/memory");
    const header = page.locator("header[data-mobile-header]");
    await expect(header).toBeVisible({ timeout: 30_000 });
    const pageLeft = () =>
      page.evaluate(() => Math.round(document.querySelector("main")!.getBoundingClientRect().left));

    await header.getByRole("button", { name: "Open sidebar", exact: true }).click();
    await expect.poll(() => pageLeft()).toBe(192);
    await page.getByRole("button", { name: "Hide names", exact: true }).click();
    await expect(page.locator('aside a[href="/apps"]')).toHaveText("");
    expect(await railWidth(page)).toBe(64);
    await expect.poll(() => pageLeft()).toBe(64);

    await page.reload();
    await header.getByRole("button", { name: "Open sidebar", exact: true }).click();
    await expect.poll(() => pageLeft()).toBe(64);
    await page.getByRole("button", { name: "Show names", exact: true }).click();
    await expect.poll(() => pageLeft()).toBe(192);
  });
});
