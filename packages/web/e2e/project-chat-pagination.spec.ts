import { expect, test, type BrowserContext } from "@playwright/test";
import type { ProjectDashboardChat, ProjectDashboardResponse } from "@rome/api-types/projects";

function buildChats(count: number): ProjectDashboardChat[] {
  return Array.from({ length: count }, (_, index) => ({
    createdAt: "2026-09-01T12:00:00.000Z",
    id: `pagination-chat-${index}`,
    messageCount: 2,
    searchText: `Conversation ${index}`,
    snippet: `Conversation ${index}`,
    title: `Chat ${index}`,
    updatedAt: "2026-09-01T12:00:00.000Z",
  }));
}

async function mockDashboard(context: BrowserContext, chats: ProjectDashboardChat[]) {
  const requests: URL[] = [];
  const pageFor = (offset: number, limit: number) => ({
    hasMore: offset + limit < chats.length,
    limit,
    nextCursor: offset + limit < chats.length ? String(offset + limit) : null,
    total: chats.length,
  });
  const dashboard: ProjectDashboardResponse = {
    availableProjectPaths: [],
    chats: chats.slice(0, 20),
    chatPage: pageFor(0, 20),
    logicalPath: "projects",
    name: "All projects",
    relativePath: "",
    stats: {
      cacheHitRate: 0,
      chatCount: chats.length,
      monthBudgetUsd: null,
      monthCostUsd: 0,
      monthTokens: 0,
      totalCostUsd: 0,
      totalTokens: 0,
    },
    providerUsage: { month: [], total: [] },
    usage: [],
  };
  await context.route("**/api/projects/dashboard?*", (route) => route.fulfill({ json: dashboard }));
  await context.route("**/api/projects/dashboard/chats?*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const offset = Number(url.searchParams.get("cursor"));
    const limit = Number(url.searchParams.get("limit"));
    return route.fulfill({
      json: { chats: chats.slice(offset, offset + limit), page: pageFor(offset, limit) },
    });
  });
  return requests;
}

test.use({ viewport: { width: 1440, height: 900 } });

test("search continues through pages with no matches without another scroll", async ({
  context,
  page,
}) => {
  const chats = buildChats(60);
  chats[0].title = "SF initial match";
  chats[40].title = "SF later match";
  const requests = await mockDashboard(context, chats);

  await page.goto("/projects");
  await expect(page.getByText("20 of 60 chats")).toBeVisible();
  await page.getByPlaceholder("Search chats…").fill("sf");

  await expect(page.getByRole("link", { name: /SF later match/ })).toBeVisible();
  await expect(page.getByText("Scroll for more chats")).toHaveCount(0);
  expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual(["20", "40"]);
  expect(requests.map((url) => url.searchParams.get("limit"))).toEqual(["20", "20"]);

  await page.getByPlaceholder("Search chats…").fill("missing");
  await expect(page.getByText("No chats match “missing”.")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByText("20 of 60 chats")).toBeVisible();
  await page.getByText("Scroll for more chats").scrollIntoViewIfNeeded();
  await expect(page.getByText("40 of 60 chats")).toBeVisible();
  expect(requests).toHaveLength(2);
});

test("each scroll appends 20 chats and preserves the scroll position", async ({
  context,
  page,
}) => {
  const requests = await mockDashboard(context, buildChats(60));

  await page.goto("/projects");
  await expect(page.getByText("20 of 60 chats")).toBeVisible();
  const sentinel = page.getByText("Scroll for more chats");
  await sentinel.scrollIntoViewIfNeeded();
  await expect(page.getByText("40 of 60 chats")).toBeVisible();
  expect(requests).toHaveLength(1);
  await expect(page.getByRole("link", { name: /^Chat 19 / })).toBeInViewport();

  await sentinel.scrollIntoViewIfNeeded();
  await expect(page.getByText("60 of 60 chats")).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests.map((url) => url.searchParams.get("limit"))).toEqual(["20", "20"]);
  await expect(sentinel).toHaveCount(0);
});

test("a search scroll adds 20 matches across sparse pages and keeps leftover matches", async ({
  context,
  page,
}) => {
  const chats = buildChats(80);
  for (const [index, chat] of chats.entries()) {
    if (index <= 20 || index >= 60) chat.title = `SF chat ${index}`;
  }
  const requests = await mockDashboard(context, chats);

  await page.goto("/projects");
  await expect(page.getByText("20 of 80 chats")).toBeVisible();
  await page.getByPlaceholder("Search chats…").fill("sf");
  const sentinel = page.getByText("Scroll for more chats");
  await sentinel.scrollIntoViewIfNeeded();

  await expect(page.getByText("40 of 80 chats")).toBeVisible();
  await expect(page.getByRole("link", { name: /SF chat 79/ })).toHaveCount(0);
  expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual(["20", "40", "60"]);
  expect(requests.map((url) => url.searchParams.get("limit"))).toEqual(["20", "20", "20"]);

  await sentinel.scrollIntoViewIfNeeded();
  await expect(page.getByText("41 of 80 chats")).toBeVisible();
  await expect(page.getByRole("link", { name: /SF chat 79/ })).toBeVisible();
  await expect(sentinel).toHaveCount(0);
  expect(requests).toHaveLength(3);
});

test("a failed page waits for retry before filling the search batch", async ({ context, page }) => {
  const chats = buildChats(60);
  chats[0].title = "SF initial match";
  chats[40].title = "SF later match";
  const requests = await mockDashboard(context, chats);
  await context.route(
    "**/api/projects/dashboard/chats?*",
    (route) => route.fulfill({ status: 500 }),
    { times: 1 },
  );

  await page.goto("/projects");
  await expect(page.getByText("20 of 60 chats")).toBeVisible();
  await page.getByPlaceholder("Search chats…").fill("sf");
  const retry = page.getByRole("button", { name: "Retry loading chats" });
  await expect(retry).toBeVisible();
  expect(requests).toHaveLength(0);

  await retry.click();
  await expect(page.getByRole("link", { name: /SF later match/ })).toBeVisible();
  await expect(retry).toHaveCount(0);
  expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual(["20", "40"]);
});

for (const action of ["clear", "change"] as const) {
  test(`${action} search resets a scrolled list to its first batch`, async ({ context, page }) => {
    const requests = await mockDashboard(context, buildChats(80));

    await page.goto("/projects");
    await expect(page.getByText("20 of 80 chats")).toBeVisible();
    await page.getByPlaceholder("Search chats…").fill("chat");
    const sentinel = page.getByText("Scroll for more chats");
    await sentinel.scrollIntoViewIfNeeded();
    await expect(page.getByText("40 of 80 chats")).toBeVisible();
    await sentinel.scrollIntoViewIfNeeded();
    await expect(page.getByText("60 of 80 chats")).toBeVisible();
    const firstChat = page.getByRole("link", { name: /^Chat 0 / });
    await expect(firstChat).not.toBeInViewport();

    if (action === "clear") {
      await page.getByRole("button", { name: "Clear search" }).click();
    } else {
      await page.getByPlaceholder("Search chats…").fill("conversation");
    }

    await expect(firstChat).toBeInViewport();
    await expect(page.getByText("20 of 80 chats")).toBeVisible();
    expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual(["20", "40"]);
    await sentinel.scrollIntoViewIfNeeded();
    await expect(page.getByText("40 of 80 chats")).toBeVisible();
    expect(requests).toHaveLength(2);
  });

  test(`${action} search keeps cached chats pageable after a later page fails`, async ({
    context,
    page,
  }) => {
    const requests = await mockDashboard(context, buildChats(80));
    let failedRequests = 0;
    await context.route("**/api/projects/dashboard/chats?*", (route) => {
      if (new URL(route.request().url()).searchParams.get("cursor") !== "60") {
        return route.fallback();
      }
      failedRequests += 1;
      return route.fulfill({ status: 500 });
    });

    await page.goto("/projects");
    await expect(page.getByText("20 of 80 chats")).toBeVisible();
    await page.getByPlaceholder("Search chats…").fill("chat");
    const sentinel = page.getByText("Scroll for more chats");
    await sentinel.scrollIntoViewIfNeeded();
    await expect(page.getByText("40 of 80 chats")).toBeVisible();
    await sentinel.scrollIntoViewIfNeeded();
    await expect(page.getByText("60 of 80 chats")).toBeVisible();
    await sentinel.scrollIntoViewIfNeeded();
    const retry = page.getByRole("button", { name: "Retry loading chats" });
    await expect(retry).toBeVisible();

    if (action === "clear") {
      await page.getByRole("button", { name: "Clear search" }).click();
    } else {
      await page.getByPlaceholder("Search chats…").fill("conversation");
    }
    await expect(page.getByRole("link", { name: /^Chat 0 / })).toBeInViewport();
    await expect(page.getByText("20 of 80 chats")).toBeVisible();
    await expect(retry).toHaveCount(0);
    await sentinel.scrollIntoViewIfNeeded();
    await expect(page.getByText("40 of 80 chats")).toBeVisible();
    await sentinel.scrollIntoViewIfNeeded();
    await expect(page.getByText("60 of 80 chats")).toBeVisible();
    await expect(retry).toBeVisible();
    expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual(["20", "40"]);
    expect(failedRequests).toBe(1);

    await retry.click();
    await expect(retry).toBeVisible();
    expect(failedRequests).toBe(2);
    await expect(page.getByText("60 of 80 chats")).toBeVisible();
  });
}
