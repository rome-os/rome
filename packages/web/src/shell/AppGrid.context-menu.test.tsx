// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import i18n from "@/i18n";
import { AppGrid, STORAGE_KEY } from "./AppGrid";

const apps = [
  {
    id: "recipe-box",
    displayName: "Recipe Box",
    status: "active",
    hasFrontend: true,
    href: "/apps/recipe-box",
    iconUrl: null,
  },
];

const fetchMock = rs.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === "/api/apps") {
    return new Response(JSON.stringify({ apps }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "/api/apps/updates") {
    return new Response(JSON.stringify({ upgradable: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "/api/settings" && (!init?.method || init.method === "GET")) {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "/api/settings" && init?.method === "PUT") {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(null, { status: 404 });
});

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {JSON.stringify({
        pathname: location.pathname,
        search: location.search,
        state: location.state,
      })}
    </output>
  );
}

function renderSidebar(collapsed: boolean, initialPath = "/apps") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AppGrid collapsed={collapsed} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function findPinnedAppLink(): Promise<HTMLAnchorElement> {
  let link: HTMLAnchorElement | null = null;
  await waitFor(() => {
    link = document.querySelector('a[href="/apps/recipe-box"]');
    expect(link).toBeTruthy();
  });
  return link as HTMLAnchorElement;
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
  localStorage.setItem("rome-sidebar-apps", JSON.stringify(apps));
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ type: "app", id: "recipe-box" }]));
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
  localStorage.clear();
});

describe.each([
  ["expanded sidebar", false],
  ["collapsed rail", true],
] as const)("pinned app context menu in the %s", (_name, collapsed) => {
  it("offers normal, split-view, and unpin actions", async () => {
    renderSidebar(collapsed);

    fireEvent.contextMenu(await findPinnedAppLink());

    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open", "Open in split view", "Unpin from sidebar"]);
  });
});

it("opens a pinned app beside a new chat from another page", async () => {
  const user = userEvent.setup();
  renderSidebar(false, "/projects");

  fireEvent.contextMenu(await findPinnedAppLink());
  await user.click(await screen.findByRole("menuitem", { name: "Open in split view" }));

  expect(screen.getByTestId("location").textContent).toBe(
    JSON.stringify({
      pathname: "/chat",
      search: "",
      state: { widgets: [{ type: "app", appId: "recipe-box" }] },
    }),
  );
});

it("keeps the active chat when opening a pinned app in split view", async () => {
  const user = userEvent.setup();
  renderSidebar(false, "/chat/session-1?hideSidebar=1");

  fireEvent.contextMenu(await findPinnedAppLink());
  await user.click(await screen.findByRole("menuitem", { name: "Open in split view" }));

  expect(screen.getByTestId("location").textContent).toBe(
    JSON.stringify({
      pathname: "/chat/session-1",
      search: "?hideSidebar=1",
      state: { widgets: [{ type: "app", appId: "recipe-box" }] },
    }),
  );
});

it("unpins the app from its context menu", async () => {
  const user = userEvent.setup();
  renderSidebar(false);

  fireEvent.contextMenu(await findPinnedAppLink());
  await user.click(await screen.findByRole("menuitem", { name: "Unpin from sidebar" }));

  expect(document.querySelector('a[href="/apps/recipe-box"]')).toBeNull();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).not.toContainEqual({
    type: "app",
    id: "recipe-box",
  });
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"sidebarPins"'),
      }),
    );
  });
});
