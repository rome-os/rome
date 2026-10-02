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
  delete window.rome;
});

describe.each([
  ["expanded sidebar", false],
  ["collapsed rail", true],
] as const)("pinned app context menu in the %s", (_name, collapsed) => {
  it("offers new-tab, chat-with-app, details, and unpin actions", async () => {
    renderSidebar(collapsed);

    fireEvent.contextMenu(await findPinnedAppLink());

    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open in new tab", "Chat with app", "View details", "Unpin from sidebar"]);
  });
});

it("opens a pinned app in a new tab, since a plain click already opens it here", async () => {
  renderSidebar(false);

  fireEvent.contextMenu(await findPinnedAppLink());

  const item = await screen.findByRole("menuitem", { name: "Open in new tab" });
  expect(item.getAttribute("href")).toBe("/apps/recipe-box");
  expect(item.getAttribute("target")).toBe("_blank");
});

it("keeps a plain Open on a touch device, where the mobile app's WebView has no tabs to open", async () => {
  // Same query `useCoarsePointer` asks; every other query keeps jsdom's answer
  // of "no match", so nothing else about the layout changes.
  rs.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(hover: none) and (pointer: coarse)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  renderSidebar(false);

  fireEvent.contextMenu(await findPinnedAppLink());

  const item = await screen.findByRole("menuitem", { name: "Open" });
  expect(item.getAttribute("href")).toBe("/apps/recipe-box");
  expect(item.getAttribute("target")).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Open in new tab" })).toBeNull();
});

it("keeps a plain Open in the Mac app, where a new tab lands in a browser with no Rome session", async () => {
  window.rome = {};
  renderSidebar(false);

  fireEvent.contextMenu(await findPinnedAppLink());

  const item = await screen.findByRole("menuitem", { name: "Open" });
  expect(item.getAttribute("href")).toBe("/apps/recipe-box");
  expect(item.getAttribute("target")).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Open in new tab" })).toBeNull();
});

it("opens a pinned app beside a new chat from another page", async () => {
  const user = userEvent.setup();
  renderSidebar(false, "/projects");

  fireEvent.contextMenu(await findPinnedAppLink());
  await user.click(await screen.findByRole("menuitem", { name: "Chat with app" }));

  expect(screen.getByTestId("location").textContent).toBe(
    JSON.stringify({
      pathname: "/chat",
      search: "",
      state: { widgets: [{ type: "app", appId: "recipe-box" }] },
    }),
  );
});

it("keeps the active chat when chatting with a pinned app", async () => {
  const user = userEvent.setup();
  renderSidebar(false, "/chat/session-1?hideSidebar=1");

  fireEvent.contextMenu(await findPinnedAppLink());
  await user.click(await screen.findByRole("menuitem", { name: "Chat with app" }));

  expect(screen.getByTestId("location").textContent).toBe(
    JSON.stringify({
      pathname: "/chat/session-1",
      search: "?hideSidebar=1",
      state: { widgets: [{ type: "app", appId: "recipe-box" }] },
    }),
  );
});

it("opens a pinned app's details page from its context menu", async () => {
  const user = userEvent.setup();
  renderSidebar(false);

  fireEvent.contextMenu(await findPinnedAppLink());
  await user.click(await screen.findByRole("menuitem", { name: "View details" }));

  expect(JSON.parse(screen.getByTestId("location").textContent ?? "{}").pathname).toBe(
    "/app-details/recipe-box",
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

describe("pinned built-in page context menu", () => {
  beforeEach(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { type: "builtin", id: "people" },
        { type: "app", id: "recipe-box" },
      ]),
    );
  });

  async function findBuiltinLink(href: string): Promise<HTMLAnchorElement> {
    let link: HTMLAnchorElement | null = null;
    await waitFor(() => {
      link = document.querySelector(`nav a[href="${href}"]`);
      expect(link).toBeTruthy();
    });
    return link as HTMLAnchorElement;
  }

  it.each([
    ["expanded sidebar", false],
    ["collapsed rail", true],
  ] as const)("offers new-tab and unpin, like an app row, in the %s", async (_name, collapsed) => {
    renderSidebar(collapsed);

    fireEvent.contextMenu(await findBuiltinLink("/people"));

    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open in new tab", "Unpin from sidebar"]);
    expect(
      within(menu).getByRole("menuitem", { name: "Open in new tab" }).getAttribute("href"),
    ).toBe("/people");
  });

  it("unpins the page from its context menu and keeps the app pin", async () => {
    const user = userEvent.setup();
    renderSidebar(false);

    fireEvent.contextMenu(await findBuiltinLink("/people"));
    await user.click(await screen.findByRole("menuitem", { name: "Unpin from sidebar" }));

    expect(document.querySelector('nav a[href="/people"]')).toBeNull();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    expect(stored).not.toContainEqual({ type: "builtin", id: "people" });
    expect(stored).toContainEqual({ type: "app", id: "recipe-box" });
  });

  it("offers no unpin on a required pin", async () => {
    renderSidebar(false, "/projects");

    fireEvent.contextMenu(await findBuiltinLink("/chat"));

    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open in new tab"]);
  });

  it("opens no menu on a required pin where there are no tabs, since Open would only repeat a click", async () => {
    window.rome = {};
    renderSidebar(false, "/projects");

    fireEvent.contextMenu(await findBuiltinLink("/chat"));

    // A menu that would open does so synchronously on the contextmenu event.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([
    ["in the browser", false],
    ["in the Mac app", true],
  ] as const)("offers only unpin on the App Store row %s", async (_name, inDesktopApp) => {
    if (inDesktopApp) window.rome = {};
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ type: "builtin", id: "store" }]));
    renderSidebar(false);

    let trigger: Element | null = null;
    await waitFor(() => {
      trigger = document.querySelector('nav [title="App Store"]');
      expect(trigger).toBeTruthy();
    });
    expect((trigger as unknown as Element).tagName).toBe(inDesktopApp ? "BUTTON" : "A");
    fireEvent.contextMenu(trigger as unknown as Element);

    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Unpin from sidebar"]);
  });
});
