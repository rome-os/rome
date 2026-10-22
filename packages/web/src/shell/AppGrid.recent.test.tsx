// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { AppGrid, STORAGE_KEY } from "./AppGrid";

const LAST_OPENED_KEY = "rome-app-last-opened";
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();

interface FixtureApp {
  id: string;
  displayName: string;
  status: string;
  hasFrontend: boolean;
  href: string;
  iconUrl: string;
  origin: "local" | "builtin" | "appstore";
  installedAt: string | null;
}

function fixture(id: string, displayName: string, extra: Partial<FixtureApp> = {}): FixtureApp {
  return {
    id,
    displayName,
    status: "active",
    hasFrontend: true,
    href: `/apps/${id}`,
    // A real icon URL on purpose: the letter fallback would put "A" in front of
    // "Alpha" in every link's text and accessible name.
    iconUrl: `/api/apps/${id}/icon`,
    origin: "local",
    installedAt: null,
    ...extra,
  };
}

let apps: FixtureApp[] = [];

const fetchMock = rs.fn(
  async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url === "/api/apps") return json({ apps });
    if (url === "/api/apps/updates") return json({ upgradable: [] });
    if (url === "/api/settings") return json({});
    return new Response(null, { status: 404 });
  },
);

function renderSidebar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/chat"]}>
        <AppGrid />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function seed(nextApps: FixtureApp[], lastOpened: Record<string, string>) {
  apps = nextApps;
  localStorage.setItem("rome-sidebar-apps", JSON.stringify(nextApps));
  localStorage.setItem(LAST_OPENED_KEY, JSON.stringify(lastOpened));
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

describe("Recent apps on the rail", () => {
  it("lists recent unpinned apps newest first, below a divider, without system apps", async () => {
    seed(
      [
        fixture("a", "Alpha"),
        fixture("b", "Bravo", { installedAt: minutesAgo(1) }),
        fixture("sys", "System Thing", { origin: "builtin", installedAt: minutesAgo(1) }),
        fixture("user-skills", "User Skills", { installedAt: minutesAgo(1) }),
      ],
      { a: minutesAgo(30) },
    );
    renderSidebar();

    await screen.findByRole("link", { name: "Alpha" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/apps", expect.anything()));
    const nav = screen.getByRole("navigation");
    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label"));
    expect(labels.slice(-2)).toEqual(["Bravo", "Alpha"]);
    expect(labels).not.toContain("System Thing");
    expect(labels).not.toContain("User Skills");
    const bravo = screen.getByRole("link", { name: "Bravo" });
    expect(bravo.previousElementSibling?.getAttribute("data-orientation")).toBe("horizontal");
  });

  it("leaves a pinned app out of Recent, and Pin from the menu moves it to the pins", async () => {
    seed([fixture("a", "Alpha"), fixture("b", "Bravo")], {
      a: minutesAgo(1),
      b: minutesAgo(2),
    });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { type: "builtin", id: "apps" },
        { type: "app", id: "b" },
      ]),
    );
    const user = userEvent.setup();
    renderSidebar();

    fireEvent.contextMenu(await screen.findByRole("link", { name: "Alpha" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open in new tab", "Chat with app", "View details", "Pin to sidebar"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Pin to sidebar" }));

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toContainEqual({
      type: "app",
      id: "a",
    });
    // Both apps are pins now, so Recent and its divider are gone and only the
    // divider between Rome's surfaces and the pins is left.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-orientation="horizontal"]')).toHaveLength(1),
    );
    expect(screen.getAllByRole("link", { name: "Alpha" })).toHaveLength(1);
  });

  it("names a recent app in a tooltip on hover", async () => {
    seed([fixture("a", "Alpha")], { a: minutesAgo(1) });
    const user = userEvent.setup();
    renderSidebar();

    await user.hover(await screen.findByRole("link", { name: "Alpha" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Alpha");
  });

  it("shows three tiles and puts the rest behind a More button", async () => {
    seed(
      [
        fixture("a", "Alpha"),
        fixture("b", "Bravo"),
        fixture("c", "Charlie"),
        fixture("d", "Delta"),
      ],
      { a: minutesAgo(1), b: minutesAgo(2), c: minutesAgo(3), d: minutesAgo(4) },
    );
    const user = userEvent.setup();
    renderSidebar();

    await screen.findByRole("link", { name: "Alpha" });
    expect(screen.getByRole("link", { name: "Bravo" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Charlie" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Delta" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "More recent apps" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Delta"]);
  });

  it("gives an overflow app the same context menu as a tile", async () => {
    seed(
      [
        fixture("a", "Alpha"),
        fixture("b", "Bravo"),
        fixture("c", "Charlie"),
        fixture("d", "Delta"),
      ],
      { a: minutesAgo(1), b: minutesAgo(2), c: minutesAgo(3), d: minutesAgo(4) },
    );
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole("button", { name: "More recent apps" }));
    const more = await screen.findByRole("menu");
    fireEvent.contextMenu(within(more).getByRole("menuitem", { name: "Delta" }));

    // The context menu is modal, so it hides the More list from the
    // accessibility tree; the list itself stays open underneath.
    const contextMenu = await screen.findByRole("menu");
    expect(contextMenu).not.toBe(more);
    expect(
      within(contextMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open in new tab", "Chat with app", "View details", "Pin to sidebar"]);

    // A choice closes the More list too, instead of leaving it over the page.
    await user.click(within(contextMenu).getByRole("menuitem", { name: "View details" }));
    await waitFor(() => expect(screen.queryAllByRole("menu", { hidden: true })).toEqual([]));
  });

  it("has no More button with three or fewer, and no tiles at all with none", async () => {
    seed([fixture("a", "Alpha")], { a: minutesAgo(1) });
    const first = renderSidebar();
    await screen.findByRole("link", { name: "Alpha" });
    expect(screen.queryByRole("button", { name: "More recent apps" })).toBeNull();
    first.unmount();

    seed([fixture("old", "Old App")], { old: daysAgo(20) });
    renderSidebar();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/apps", expect.anything()));
    expect(screen.queryByRole("link", { name: "Old App" })).toBeNull();
  });

  it("marks a never-opened app on its tile", async () => {
    seed([fixture("b", "Bravo", { installedAt: minutesAgo(1) })], {});
    renderSidebar();

    await screen.findByRole("link", { name: "Bravo" });
    expect(screen.getByRole("img", { name: "Not opened on this device" })).toBeTruthy();
  });
});
