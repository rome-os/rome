// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ProjectDashboardProviderUsage,
  ProjectDashboardResponse,
} from "@rome/api-types/projects";
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
    providerUsage: { month: [], total: [] },
    usage: [],
  };
}

function providerUsage(
  provider: string,
  inputTokens: number,
  costUsd: number,
): ProjectDashboardProviderUsage {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    inputTokens,
    outputTokens: 0,
    provider,
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
        providers: [],
      },
      {
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        costUsd: 0.2,
        date: "2026-05-31",
        inputTokens: 35,
        outputTokens: 30,
        providers: [],
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

  it("stacks the usage chart by provider", async () => {
    const dashboard = buildDashboard();
    dashboard.usage = [
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.5,
        date: "2026-05-30",
        inputTokens: 300,
        outputTokens: 0,
        providers: [providerUsage("anthropic", 100, 0.2), providerUsage("openai", 200, 0.3)],
      },
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.1,
        date: "2026-05-31",
        inputTokens: 50,
        outputTokens: 0,
        providers: [providerUsage("openai", 50, 0.1)],
      },
    ];
    mockDashboardFetch(dashboard);

    const { container } = renderDashboard("/projects/demo");

    await screen.findByRole("img", { name: "tokens usage over the last 14 days" });
    fireEvent.click(screen.getByRole("radio", { name: "By provider" }));

    const chart = screen.getByRole("img", {
      name: "tokens usage by provider over the last 14 days",
    });
    const bars = chart.querySelectorAll(".recharts-bar");
    expect(bars).toHaveLength(2);
    expect(bars[0].querySelector(".recharts-bar-rectangle path")?.getAttribute("fill")).toBe(
      "var(--primary)",
    );
    expect(bars[1].querySelector(".recharts-bar-rectangle path")?.getAttribute("fill")).toContain(
      "var(--foreground) 72%",
    );

    fireEvent.click(screen.getByRole("radio", { name: "Cost" }));

    expect(
      screen.getByRole("img", { name: "cost usage by provider over the last 14 days" }),
    ).toBeTruthy();
    expect(container.querySelectorAll(".recharts-bar")).toHaveLength(2);
  });

  it("breaks tokens and spend down by provider for the selected period", async () => {
    const dashboard = buildDashboard();
    dashboard.usage = [
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 1,
        date: "2026-05-31",
        inputTokens: 1_000,
        outputTokens: 0,
        providers: [providerUsage("openai", 1_000, 1)],
      },
    ];
    dashboard.providerUsage = {
      month: [
        providerUsage("anthropic", 2_000, 1),
        providerUsage("openai", 6_000, 3),
        providerUsage("google", 500, 0),
        providerUsage("unknown", 500, 0),
      ],
      total: [],
    };
    mockDashboardFetch(dashboard);

    renderDashboard("/projects/demo");

    const table = await screen.findByRole("table", { name: "Usage by provider, this month" });
    const rows = within(table).getAllByRole("row");
    // Header, Codex (largest share), Claude, the merged Other row, then the total.
    expect(rows.map((row) => row.querySelector("th")?.textContent)).toEqual([
      "Provider",
      "Codex",
      "Claude",
      "Other",
      "Total",
    ]);
    expect(within(rows[1]).getByText("75%")).toBeTruthy();
    expect(within(rows[1]).getByText("$3.00")).toBeTruthy();
    expect(within(rows[2]).getByText("25%")).toBeTruthy();
    expect(within(rows[3]).getByText("$0.00")).toBeTruthy();
    expect(within(rows[4]).getByText("$4.00")).toBeTruthy();
    expect(within(table).getByText("Share of spend")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "14 days" }));

    const recent = screen.getByRole("table", { name: "Usage by provider, 14 days" });
    expect(within(recent).getAllByRole("row")).toHaveLength(2);
    expect(within(recent).getByText("100%")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "All time" }));

    expect(screen.queryByRole("table", { name: /Usage by provider/ })).toBeNull();
    expect(screen.getByText("No usage recorded yet.")).toBeTruthy();
  });
});
