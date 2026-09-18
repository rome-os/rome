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

function renderSidebar(collapsed = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/chat"]}>
        <AppGrid collapsed={collapsed} />
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
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
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

describe("Recent zone, expanded sidebar", () => {
  it("renders nothing, not even a label, when no app qualifies", async () => {
    seed([fixture("old", "Old App")], { old: daysAgo(20) });
    renderSidebar();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/apps", expect.anything()));
    expect(screen.queryByRole("navigation", { name: "Recent apps" })).toBeNull();
    expect(screen.queryByText("Recent")).toBeNull();
  });

  it("lists recent unpinned apps newest first and marks the never-opened one", async () => {
    seed(
      [
        fixture("a", "Alpha"),
        fixture("b", "Bravo", { installedAt: minutesAgo(1) }),
        fixture("sys", "System Thing", { origin: "builtin", installedAt: minutesAgo(1) }),
      ],
      { a: minutesAgo(30) },
    );
    renderSidebar();

    const zone = await screen.findByRole("navigation", { name: "Recent apps" });
    expect(
      within(zone)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Bravo", "Alpha"]);
    expect(within(zone).getAllByRole("img", { name: "Not opened on this device" })).toHaveLength(1);
    expect(screen.queryByText("System Thing")).toBeNull();
  });

  it("shows three, reveals the rest on Show more, and forgets that on remount", async () => {
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
    const first = renderSidebar();

    const zone = await screen.findByRole("navigation", { name: "Recent apps" });
    expect(within(zone).getAllByRole("link")).toHaveLength(3);
    expect(within(zone).queryByText("Delta")).toBeNull();

    const toggle = within(zone).getByRole("button", { name: "Show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(within(zone).getAllByRole("link")).toHaveLength(4);
    expect(within(zone).getByRole("button", { name: "Show less" })).toBeTruthy();

    first.unmount();
    renderSidebar();
    const again = await screen.findByRole("navigation", { name: "Recent apps" });
    expect(within(again).getAllByRole("link")).toHaveLength(3);
  });

  it("has no Show more with exactly three recent apps", async () => {
    seed([fixture("a", "Alpha"), fixture("b", "Bravo"), fixture("c", "Charlie")], {
      a: minutesAgo(1),
      b: minutesAgo(2),
      c: minutesAgo(3),
    });
    renderSidebar();

    const zone = await screen.findByRole("navigation", { name: "Recent apps" });
    expect(within(zone).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("pins from the row button: the app moves to the pinned list and leaves Recent", async () => {
    seed([fixture("a", "Alpha")], { a: minutesAgo(1) });
    const user = userEvent.setup();
    renderSidebar();

    const zone = await screen.findByRole("navigation", { name: "Recent apps" });
    await user.click(within(zone).getByRole("button", { name: "Pin to sidebar" }));

    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Recent apps" })).toBeNull(),
    );
    expect(document.querySelector('a[href="/apps/a"]')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toContainEqual({
      type: "app",
      id: "a",
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({ method: "PUT", body: expect.stringContaining('"sidebarPins"') }),
      ),
    );
  });

  it("offers Pin, not Unpin, in a recent app's context menu", async () => {
    seed([fixture("a", "Alpha")], { a: minutesAgo(1) });
    renderSidebar();

    const zone = await screen.findByRole("navigation", { name: "Recent apps" });
    fireEvent.contextMenu(within(zone).getByRole("link", { name: "Alpha" }));

    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open", "Open in split view", "Pin to sidebar"]);
  });

  it("keeps Edit mode's Add list complete and without a New badge", async () => {
    seed([fixture("old", "Old App"), fixture("b", "Bravo", { installedAt: minutesAgo(1) })], {
      old: daysAgo(40),
    });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));

    expect(await screen.findByText("Old App")).toBeTruthy();
    expect(screen.getByText("Bravo")).toBeTruthy();
    expect(screen.queryByText("New")).toBeNull();
  });
});

describe("Recent zone, collapsed rail", () => {
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
    renderSidebar(true);

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

  it("has no More button with three or fewer, and no tiles at all with none", async () => {
    seed([fixture("a", "Alpha")], { a: minutesAgo(1) });
    const first = renderSidebar(true);
    await screen.findByRole("link", { name: "Alpha" });
    expect(screen.queryByRole("button", { name: "More recent apps" })).toBeNull();
    first.unmount();

    seed([fixture("old", "Old App")], { old: daysAgo(20) });
    renderSidebar(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/apps", expect.anything()));
    expect(screen.queryByRole("link", { name: "Old App" })).toBeNull();
  });

  it("marks a never-opened app on its tile", async () => {
    seed([fixture("b", "Bravo", { installedAt: minutesAgo(1) })], {});
    renderSidebar(true);

    await screen.findByRole("link", { name: "Bravo" });
    expect(screen.getByRole("img", { name: "Not opened on this device" })).toBeTruthy();
  });
});
