import { expect, test, type BrowserContext } from "@playwright/test";
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

async function mockDashboard(context: BrowserContext) {
  const chats: ProjectDashboardChat[] = Array.from({ length: 20 }, (_, index) => ({
    createdAt: "2026-09-01T12:00:00.000Z",
    id: `layout-chat-${index}`,
    messageCount: 2,
    searchText: `Conversation ${index}`,
    snippet: `Conversation ${index}`,
    title: `Chat ${index}`,
    updatedAt: "2026-09-01T12:00:00.000Z",
  }));
  const providers = [
    providerUsage("anthropic", 1_624.87),
    providerUsage("openai", 584.99),
    providerUsage("google", 12.5),
  ];
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
