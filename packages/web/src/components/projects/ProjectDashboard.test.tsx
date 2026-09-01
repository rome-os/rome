// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectDashboardResponse } from "@rome/api-types/projects";
import i18n from "@/i18n";
import { ProjectDashboard } from "./ProjectDashboard";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function buildDashboard(): ProjectDashboardResponse {
  return {
    availableProjectPaths: ["demo"],
    chats: [
      {
        createdAt: "2026-05-31T12:00:00.000Z",
        id: "sess-123",
        messageCount: 2,
        searchText: "User request Assistant response",
        snippet: "Assistant response",
        title: "Selected chat",
        updatedAt: new Date().toISOString(),
      },
    ],
    chatPage: { hasMore: false, limit: 20, nextCursor: null, total: 1 },
    logicalPath: "projects/demo",
    name: "Demo",
    relativePath: "demo",
    stats: {
      cacheHitRate: 0,
      chatCount: 1,
      monthBudgetUsd: null,
      monthCostUsd: 0,
      monthTokens: 0,
      totalCostUsd: 0,
      totalTokens: 0,
    },
    usage: [],
  };
}

function mockDashboardFetch(response: ProjectDashboardResponse) {
  rs.spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/projects/dashboard")) {
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  }) as typeof fetch);
}

function renderDashboard(initialEntry: string) {
  class TestResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
  rs.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const measuringText = this.id === "recharts_measurement_span";
    const width = measuringText ? 40 : 560;
    const height = measuringText ? 14 : 150;
    return {
      width,
      height,
      top: 0,
      right: width,
      bottom: height,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <ProjectDashboard path="projects/demo" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("ProjectDashboard", () => {
  it("links dashboard chats to the workspace session route with hideSidebar query preserved", async () => {
    mockDashboardFetch(buildDashboard());

    renderDashboard("/projects/demo?hideSidebar=1");

    const link = (await waitFor(() =>
      screen.getByRole("link", { name: /Selected chat/i }),
    )) as HTMLAnchorElement;
    expect(link.pathname).toBe("/chat/sess-123");
    expect(link.search).toBe("?hideSidebar=1");
  });

  it("links dashboard chats without a query when hideSidebar is absent", async () => {
    mockDashboardFetch(buildDashboard());

    renderDashboard("/projects/demo");

    const link = (await waitFor(() =>
      screen.getByRole("link", { name: /Selected chat/i }),
    )) as HTMLAnchorElement;
    expect(link.pathname).toBe("/chat/sess-123");
    expect(link.search).toBe("");
  });

  it("renders the usage visualization with Recharts and switches metrics", async () => {
    const dashboard = buildDashboard();
    dashboard.usage = [
      {
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costUsd: 0.12,
        date: "2026-05-30",
        inputTokens: 25,
        outputTokens: 20,
      },
      {
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        costUsd: 0.2,
        date: "2026-05-31",
        inputTokens: 35,
        outputTokens: 30,
      },
    ];
    mockDashboardFetch(dashboard);

    const { container } = renderDashboard("/projects/demo");

    expect(
      await screen.findByRole("img", { name: "tokens usage over the last 14 days" }),
    ).toBeTruthy();
    expect(container.querySelector(".recharts-wrapper")).toBeTruthy();
    const tokenBars = container.querySelectorAll(".recharts-bar");
    expect(tokenBars).toHaveLength(3);
    expect(tokenBars[0].querySelector(".recharts-bar-rectangle path")?.getAttribute("fill")).toBe(
      "var(--brand)",
    );
    expect(
      tokenBars[2].querySelector(".recharts-bar-rectangle path")?.getAttribute("fill"),
    ).toContain("var(--brand) 18%");
    expect(
      container.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick"),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll(".recharts-yAxis .recharts-cartesian-axis-tick"),
    ).toHaveLength(3);
    expect(screen.getByText("Today")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Cost" }));

    expect(screen.getByRole("img", { name: "cost usage over the last 14 days" })).toBeTruthy();
    expect(screen.getByText("Total spend")).toBeTruthy();
    expect(container.querySelectorAll(".recharts-bar")).toHaveLength(1);
  });
});
