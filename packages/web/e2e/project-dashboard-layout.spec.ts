import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type {
  ProjectDashboardChat,
  ProjectDashboardProviderUsage,
  ProjectDashboardResponse,
} from "@rome/api-types/projects";

function providerUsage(provider: string, costUsd: number): ProjectDashboardProviderUsage {
  return {
    cacheReadTokens: 40_000_000,
    cacheWriteTokens: 1_000_000,
    costUsd,
    inputTokens: 2_000_000,
    outputTokens: 500_000,
    provider,
  };
}

const DEFAULT_PROVIDERS = [
  providerUsage("anthropic", 1_624.87),
  providerUsage("openai", 584.99),
  providerUsage("google", 12.5),
];

async function mockDashboard(context: BrowserContext, providers = DEFAULT_PROVIDERS) {
  const chats: ProjectDashboardChat[] = Array.from({ length: 20 }, (_, index) => ({
    createdAt: "2026-09-01T12:00:00.000Z",
    id: `layout-chat-${index}`,
    messageCount: 2,
    searchText: `Conversation ${index}`,
    snippet: `Conversation ${index}`,
    title: `Chat ${index}`,
    updatedAt: "2026-09-01T12:00:00.000Z",
  }));
  const dashboard: ProjectDashboardResponse = {
    availableProjectPaths: [],
    chats,
    chatPage: { hasMore: false, limit: 20, nextCursor: null, total: chats.length },
    logicalPath: "projects",
    name: "All projects",
    relativePath: "",
    stats: {
      cacheHitRate: 0.9,
      chatCount: chats.length,
      monthBudgetUsd: null,
      monthCostUsd: 2_222.36,
      monthTokens: 130_500_000,
      totalCostUsd: 2_222.36,
      totalTokens: 130_500_000,
    },
    providerUsage: { month: providers, total: providers },
    usage: [],
  };
  await context.route("**/api/projects/dashboard?*", (route) => route.fulfill({ json: dashboard }));
}

test("recent chats stay reachable when the panels fill a short viewport", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await mockDashboard(context);
  await page.goto("/projects");

  const firstChat = page.getByRole("link", { name: /^Chat 0 / });
  await firstChat.scrollIntoViewIfNeeded();
  await expect(firstChat).toBeInViewport();
  const list = firstChat.locator("xpath=..");
  expect((await list.boundingBox())?.height ?? 0).toBeGreaterThan(200);
});

test("the provider period control fits a phone-width dashboard", async ({ context, page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockDashboard(context);
  await page.goto("/projects");
  // Phones open the Files tab first.
  await page.getByRole("radio", { name: "Overview" }).click();

  const allTime = page.getByRole("radio", { name: "All time" });
  // Compare against the panel, not the viewport: the body scrolls, so an overflowing
  // control can be scrolled into view while still spilling past its panel.
  const overflow = await allTime.evaluate((radio) => {
    const control = radio.closest("[role=radiogroup]")?.getBoundingClientRect();
    const panel = radio.closest("section")?.getBoundingClientRect();
    return control && panel ? control.right - panel.right : Number.POSITIVE_INFINITY;
  });
  expect(overflow).toBeLessThanOrEqual(0);
  await allTime.click();
  await expect(allTime).toHaveAttribute("aria-checked", "true");
});

async function openPhoneOverview(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/projects");
  // Phones open the Files tab first.
  await page.getByRole("radio", { name: "Overview" }).click();
  return page.getByRole("table", { name: /^Usage by provider/ });
}

// How far the table's rightmost visible cell reaches past its panel's content box.
// Positive means a figure is clipped or spills over the panel border.
async function tableOverflow(table: Locator) {
  return table.evaluate((element) => {
    const panel = element.closest("section");
    if (!panel) return Number.POSITIVE_INFINITY;
    const contentRight =
      panel.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(panel).paddingRight);
    const cells = [...element.querySelectorAll("th, td")].filter(
      (cell) => cell.getClientRects().length > 0,
    );
    return Math.max(...cells.map((cell) => cell.getBoundingClientRect().right)) - contentRight;
  });
}

for (const width of [375, 320]) {
  test(`the provider table fits a ${width}px phone dashboard`, async ({ context, page }) => {
    await mockDashboard(context);
    const table = await openPhoneOverview(page, width);

    expect(await tableOverflow(table)).toBeLessThanOrEqual(0);
    await expect(table.getByRole("columnheader", { name: "Spend" })).toBeVisible();
    await expect(table.getByRole("cell", { name: "$1624.9" })).toBeVisible();
    // Share is of spend, so the token total gives way first.
    await expect(table.getByRole("columnheader", { name: "Tokens" })).toBeHidden();
  });
}

test("a phone dashboard keeps tokens when no run reported a cost", async ({ context, page }) => {
  await mockDashboard(context, [providerUsage("anthropic", 0), providerUsage("openai", 0)]);
  const table = await openPhoneOverview(page, 375);

  expect(await tableOverflow(table)).toBeLessThanOrEqual(0);
  await expect(table.getByRole("columnheader", { name: "Tokens" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Spend" })).toBeHidden();
});

test("a wide dashboard shows every provider column", async ({ context, page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockDashboard(context);
  await page.goto("/projects");

  const table = page.getByRole("table", { name: /^Usage by provider/ });
  const headers = table.getByRole("columnheader");
  await expect(headers).toHaveText([
    "Provider",
    "Share of spend",
    "Input",
    "Output",
    "Cached",
    "Tokens",
    "Spend",
  ]);
  expect(await tableOverflow(table)).toBeLessThanOrEqual(0);
});

test("a dashboard just wide enough for every column keeps long figures inside the panel", async ({
  context,
  page,
}) => {
  // Seven-character token figures such as 987.65M overflowed this boundary before
  // fmtTokens dropped to one decimal.
  const longFigures = (provider: string, costUsd: number): ProjectDashboardProviderUsage => ({
    cacheReadTokens: 987_650_000,
    cacheWriteTokens: 0,
    costUsd,
    inputTokens: 173_450_000,
    outputTokens: 123_450_000,
    provider,
  });
  await mockDashboard(context, [
    longFigures("anthropic", 9_876.54),
    longFigures("openai", 5_432.1),
    longFigures("google", 1_234.56),
  ]);
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/projects");
  await page.getByRole("radio", { name: "Overview" }).click();
  const dashboard = page.locator(".\\@container\\/project-dashboard");
  // The breakpoint measures the dashboard, so size the viewport until the dashboard is
  // the narrowest width that still shows the token split.
  const chrome = 700 - (await dashboard.evaluate((element) => element.clientWidth));
  await page.setViewportSize({ width: 641 + chrome, height: 900 });
  expect(await dashboard.evaluate((element) => element.clientWidth)).toBe(641);

  const table = page.getByRole("table", { name: /^Usage by provider/ });
  await expect(table.getByRole("columnheader", { name: "Cached" })).toBeVisible();
  await expect(table.getByRole("cell", { name: "987.7M" }).first()).toBeVisible();
  expect(await tableOverflow(table)).toBeLessThanOrEqual(0);
});
