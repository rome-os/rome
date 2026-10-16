// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, useNavigate } from "react-router-dom";
import i18n from "@/i18n";
import { APP_NAV, AppGrid, SIDEBAR_FIXED_IDS, SIDEBAR_MORE_IDS } from "./AppGrid";

const fetchMock = rs.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  if (url === "/api/apps") return json({ apps: [] });
  if (url === "/api/apps/updates") return json({ upgradable: [] });
  if (url === "/api/settings") return json({});
  return new Response(null, { status: 404 });
});

function GoTo({ path }: { path: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(path)}>
      Go to {path}
    </button>
  );
}

function renderSidebar(initialEntry: string, { collapsed = false } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AppGrid collapsed={collapsed} />
        <GoTo path="/people" />
        <GoTo path="/memory/journal" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  fetchMock.mockClear();
  rs.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
  localStorage.clear();
});

describe("sidebar menu", () => {
  it("reaches every built-in page from the menu, the fold, the Apps header or the profile menu", () => {
    const navIds = APP_NAV.map((entry) => entry.id);
    const sidebarIds = [...SIDEBAR_FIXED_IDS, ...SIDEBAR_MORE_IDS];
    // App Store opens from the Apps page header, Settings from the profile menu.
    expect(new Set([...sidebarIds, "store", "settings"])).toEqual(new Set(navIds));
    expect(sidebarIds.filter((id) => !navIds.includes(id))).toEqual([]);
    expect(new Set(sidebarIds).size).toBe(sidebarIds.length);
  });

  it("names the fixed menu's landmark", () => {
    renderSidebar("/chat");
    expect(screen.getByRole("navigation", { name: "Menu" })).toBeTruthy();
  });
});

describe("sidebar fold", () => {
  it("reaches the Browser from the fold", async () => {
    renderSidebar("/chat");
    await userEvent.click(screen.getByRole("button", { name: "Show more pages" }));

    const fold = screen.getByRole("navigation", { name: "More" });
    expect(within(fold).getByRole("link", { name: "Browser" }).getAttribute("href")).toBe(
      "/desktop",
    );
  });

  it("reopens when the guardian moves to another of its pages", async () => {
    renderSidebar("/memory");
    await userEvent.click(screen.getByRole("button", { name: "Show fewer pages" }));
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Go to /people" }));

    const fold = screen.getByRole("navigation", { name: "More" });
    expect(within(fold).getByRole("link", { name: "People" })).toBeTruthy();
  });

  it("stays folded when the guardian moves within the same page", async () => {
    renderSidebar("/memory");
    await userEvent.click(screen.getByRole("button", { name: "Show fewer pages" }));

    await userEvent.click(screen.getByRole("button", { name: "Go to /memory/journal" }));

    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
  });

  it("starts open on one of its pages, before any effect runs", () => {
    localStorage.setItem("rome-sidebar-more-expanded", "0");
    // Server rendering runs no effects, so this is the markup of the first
    // paint.
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/memory"]}>
          <AppGrid />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(markup).toContain('id="sidebar-more"');
  });

  it("points the toggle at the rows only while they are in the page", async () => {
    renderSidebar("/chat");
    const toggle = screen.getByRole("button", { name: "Show more pages" });
    expect(toggle.hasAttribute("aria-controls")).toBe(false);

    await userEvent.click(toggle);
    expect(
      screen.getByRole("button", { name: "Show fewer pages" }).getAttribute("aria-controls"),
    ).toBe("sidebar-more");
  });

  it("marks the current page in the rail's More menu", async () => {
    renderSidebar("/memory", { collapsed: true });
    await userEvent.click(screen.getByRole("button", { name: "More" }));

    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Memory" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(menu).getByRole("menuitem", { name: "People" }).hasAttribute("aria-current"),
    ).toBe(false);
  });
});
