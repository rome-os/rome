import { expect, test } from "@playwright/test";

const story = (id: string, mode = "light", locale = "en") =>
  `/iframe.html?id=connections-pairing-${id}&viewMode=story&globals=colorMode:${mode};locale:${locale}`;

test("pairing interactions stay local throughout approval, rejection, and copy", async ({
  page,
}) => {
  const requests: string[] = [];
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin || url.pathname.startsWith("/api/")) requests.push(url.href);
  });
  await page.goto(story("request--interactive"));
  await page.getByText("Pair with a verification code", { exact: true }).press("Enter");
  await expect(page.getByText("RP-12AB34CD", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Code copied" })).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await expect(page.getByText("RP-12AB34CD", { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(requests).toEqual([]);
});

for (const mode of ["light", "dark"]) {
  test(`pairing long identities and Chinese fit a phone in ${mode} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    for (const id of [
      "request--long-identity",
      "request--default",
      "confirmation--confirm",
      "request--interactive",
    ]) {
      await page.goto(story(id, mode, "zh-CN"));
      await expect(page.getByText(/Alex|Alexandra/).first()).toBeVisible();
      if (id === "request--interactive") {
        await page.locator("summary").click();
        await expect(page.getByText("RP-12AB34CD", { exact: true })).toBeVisible();
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(320);
      await expect(page.locator("html")).toHaveClass(mode === "dark" ? /dark/ : /^(?!.*dark)/);
    }
  });
}

test("submission guards and manual confirmation render", async ({ page }) => {
  await page.goto(story("confirmation--submitting"));
  await expect(page.getByRole("button", { name: "Approving…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goto(story("request--approval-interaction"));
  const confirmation = page.getByRole("dialog");
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
});

test("language toolbar updates an open interaction without resetting it", async ({ page }) => {
  await page.goto("/?path=/story/connections-pairing-request--interactive&globals=locale:en");
  const canvas = page.frameLocator("#storybook-preview-iframe");
  await canvas.getByText("Pair with a verification code", { exact: true }).click();
  await canvas.getByRole("button", { name: "Copy", exact: true }).click();
  await canvas.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: /Preview language/ }).click();
  await page.getByRole("option", { name: "中文", exact: true }).click();
  const dialog = canvas.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await expect(canvas.locator("html")).toHaveAttribute("lang", "zh-CN");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(canvas.locator("details")).toHaveAttribute("open", "");
  await expect(canvas.getByText("RP-12AB34CD", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Preview language/ }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(canvas.getByRole("button", { name: "Code copied" })).toBeVisible();
  await page.reload();
  await expect(canvas.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
});

test("long IDs stay on one line and expose their full value on hover and focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(story("request--long-identity"));
  const identity = page.locator('[aria-label^="ID "]');
  const full = (await identity.getAttribute("aria-label"))!.slice(3);
  await expect(identity).toContainText("…");
  await expect(identity).not.toContainText(full);
  await expect(identity).toHaveCSS("white-space", "nowrap");
  await identity.hover();
  await expect(page.getByRole("tooltip")).toHaveText(full);
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await identity.focus();
  await expect(page.getByRole("tooltip")).toHaveText(full);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(320);
});

test("request actions sit right on wide cards and below the details on narrow cards", async ({
  page,
}) => {
  for (const width of [900, 320]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(story("request--default"));
    const name = page.getByRole("heading", { name: "Alex", exact: true });
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeVisible();
    const heading = (await name.boundingBox())!;
    const action = (await approve.boundingBox())!;
    const metadata = (await page.getByText(/Requested .*Valid for/).boundingBox())!;
    if (width === 900) {
      expect(action.x).toBeGreaterThan(metadata.x + metadata.width);
      expect(
        Math.abs(action.y + action.height / 2 - (heading.y + metadata.y + metadata.height) / 2),
      ).toBeLessThan(2);
    } else {
      expect(action.y).toBeGreaterThan(metadata.y + metadata.height);
      expect(Math.abs(action.x - heading.x)).toBeLessThan(2);
    }
  }
});

test("resolved status replaces actions and exposes audit details in a tooltip", async ({
  page,
}) => {
  for (const width of [900, 320]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(story("request--approved"));
    const status = page.getByText("Approved", { exact: true });
    await expect(status).toBeVisible();
    await expect(page.getByText(/Resolved by guardian/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    const location = (await status.boundingBox())!;
    const metadata = (await page.getByText(/Requested .*Valid for/).boundingBox())!;
    if (width === 900) {
      expect(location.x).toBeGreaterThan(metadata.x + metadata.width);
      const heading = (await page
        .getByRole("heading", { name: "Alex", exact: true })
        .boundingBox())!;
      expect(
        Math.abs(location.y + location.height / 2 - (heading.y + metadata.y + metadata.height) / 2),
      ).toBeLessThan(2);
    } else expect(location.y).toBeGreaterThan(metadata.y + metadata.height);
    await status.hover();
    await expect(page.getByRole("tooltip")).toContainText("Resolved by guardian");
    await expect(page.getByRole("tooltip")).toContainText("2026");
    await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    await status.focus();
    await expect(page.getByRole("tooltip")).toContainText("Resolved by guardian");
  }
});

test("collapsed verification row has equal space above and below its hit area", async ({
  page,
}) => {
  for (const width of [900, 320]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(story("request--interactive"));
    const summary = page.locator("summary");
    await expect(summary).toBeVisible();
    const spacing = await summary.evaluate((element) => {
      const footer = element.closest("details")!.parentElement!;
      const card = element.closest("section")!;
      const row = element.getBoundingClientRect();
      return {
        above:
          row.top -
          footer.getBoundingClientRect().top -
          parseFloat(getComputedStyle(footer).borderTopWidth),
        below:
          card.getBoundingClientRect().bottom -
          parseFloat(getComputedStyle(card).borderBottomWidth) -
          row.bottom,
      };
    });
    expect(spacing.above).toBe(8);
    expect(spacing.below).toBe(spacing.above);
  }
});

test("loading uses a responsive skeleton with accessible status and reduced motion", async ({
  page,
}) => {
  for (const width of [900, 320]) {
    await page.setViewportSize({ width, height: 650 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/iframe.html?id=connections-pairing-requests--loading&globals=locale:en");
    const status = page.getByRole("status");
    await expect(status).toHaveText("Loading…");
    await expect(status.locator('[data-slot="skeleton"]')).toHaveCount(5);
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "View all requests in Activity" })).toBeVisible();
    const grid = status.locator('[aria-hidden="true"] > div');
    await expect(grid).toHaveCSS("animation-name", "pulse");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(grid).toHaveCSS("animation-name", "none");
    for (const skeleton of await status.locator('[data-slot="skeleton"]').all()) {
      await expect(skeleton).toHaveCSS("animation-name", "none");
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
  }
});
