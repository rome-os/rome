// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstalledAppCard, SpecSource } from "@rome/api-types/apps";
import { toast } from "sonner";
import i18n from "@/i18n";
import AppsIndexPage from "./AppsIndexPage";

// Lifecycle failures surface as toasts (the launcher tiles have no room for
// an inline error strip); mock sonner so tests can assert on them without
// mounting the Toaster.
rs.mock("sonner", () => ({
  toast: Object.assign(
    rs.fn(() => "toast-id"),
    {
      success: rs.fn(),
      error: rs.fn(),
      dismiss: rs.fn(),
    },
  ),
}));

rs.mock("@/components/logo", () => ({
  RomeLogo: ({ className }: { className?: string }) => (
    <span className={className} data-testid="rome-logo" />
  ),
}));

// The built-in nav grid imports .svg icons that resolve to URL strings under
// Rstest (not React components), which jsdom rejects as element names. The
// real icons are irrelevant to apps reactivity, so stub them with components.
rs.mock("@/shell/AppGrid", () => ({
  APP_NAV: [
    { id: "apps", href: "/apps", labelKey: "nav.apps", Icon: () => null },
    { id: "chat", href: "/chat", labelKey: "nav.chat", Icon: () => null },
    { id: "projects", href: "/projects", labelKey: "nav.projects", Icon: () => null },
  ],
  DEFAULT_SIDEBAR_PINS: [
    { type: "builtin" as const, id: "apps" },
    { type: "builtin" as const, id: "chat" },
    { type: "builtin" as const, id: "projects" },
  ],
  STORAGE_KEY: "rome-sidebar-pins",
  normalizeSidebarPins: (
    pins: Array<{ type: "builtin" | "app"; id: string }>,
  ): Array<{ type: "builtin" | "app"; id: string }> => {
    const required = [
      { type: "builtin" as const, id: "apps" },
      { type: "builtin" as const, id: "chat" },
    ];
    const requiredIds = new Set(required.map((pin) => pin.id));
    return [
      ...required,
      ...pins.filter((pin) => !(pin.type === "builtin" && requiredIds.has(pin.id))),
    ];
  },
}));

// These are the page's reactivity contracts, not its internals: after a
// lifecycle write the cards must reflect what the server now reports, not a
// hand-merged local guess. Each test stands up a tiny stateful fake backend
// whose /api/apps response *changes* as a side effect of the mutation, so the
// assertions only pass if the page re-reads server truth after writing.

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // Radix menu + dialog poke pointer-capture and scrollIntoView, which jsdom omits.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  // Radix tooltip arrows measure themselves with ResizeObserver, also absent.
  class TestResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.clearAllMocks();
  localStorage.clear();
});

const SOURCE: SpecSource = { mode: "bundle", path: "/seeds/x" };

function installedCard(
  overrides: Partial<InstalledAppCard> & Pick<InstalledAppCard, "id" | "displayName">,
): InstalledAppCard {
  return {
    version: "1.0.0",
    description: "",
    status: "active",
    phase: "installed",
    hasFrontend: false,
    href: null,
    fullHref: null,
    capabilities: [],
    capabilityDetails: { agents: [], actions: [], skills: [], hooks: [] },
    isEnabled: true,
    canToggle: true,
    canUninstall: true,
    canPublish: true,
    accessMode: "private",
    isPublic: false,
    cloudAllowedEmails: [],
    canManagePublicAccess: false,
    source: SOURCE,
    projectPath: null,
    origin: "local",
    iconUrl: null,
    ...overrides,
  };
}

// Mutable server state; POST/DELETE mutate the installed list, so the next
// GET /api/apps reflects the new truth — exactly what a refetch sees.
interface FakeUpgradeCandidate {
  appId: string;
  currentVersion: string;
  availableVersion: string;
  targetSource: SpecSource;
}

function mockBackend(initial: {
  installed: InstalledAppCard[];
  onInstall?: (id: string) => InstalledAppCard;
  upgradable?: FakeUpgradeCandidate[];
  appsGate?: Promise<void>;
  /** When set, POST /apps/:id/publish fails with this store rejection message. */
  publishError?: string;
  /**
   * When set, DELETE /apps/:id awaits this promise before completing — lets a
   * test observe the in-flight uninstall window (the card's "Uninstalling…"
   * footer) before the refetch removes the card.
   */
  deleteGate?: Promise<void>;
}) {
  const installed = [...initial.installed];

  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    // Deep-clone every response so the query cache holds a snapshot, not a live
    // reference into `installed`. Otherwise an in-place mutation would be
    // visible without a refetch, and the assertions wouldn't actually prove
    // the invalidate-and-refetch contract.
    const ok = (json: unknown) =>
      ({ ok: true, status: 200, json: async () => structuredClone(json) }) as Response;

    if (url === "/api/auth/me" && method === "GET") {
      return ok({ kind: "guardian", userId: "ray", displayName: "Ray", avatarUrl: null });
    }
    if (url === "/api/apps" && method === "GET") {
      if (initial.appsGate) await initial.appsGate;
      return ok({ apps: installed });
    }
    if (url === "/api/apps" && method === "POST") {
      // The daemon derives the appId from the source; the fake derives it
      // from the last segment of the source path (upgrades re-POST the
      // installed source).
      const body = JSON.parse(String(init?.body ?? "{}")) as { source?: { path?: string } };
      const id = body.source?.path?.split("/").pop() ?? "";
      const card = initial.onInstall?.(id) ?? installedCard({ id, displayName: id });
      const idx = installed.findIndex((a) => a.id === id);
      if (idx >= 0) installed.splice(idx, 1, card);
      else installed.push(card);
      return ok({ appId: id, spec: { source: body.source, enabled: true }, phase: "installed" });
    }
    if (url === "/api/apps/updates") {
      return ok({ upgradable: initial.upgradable ?? [] });
    }
    const publishMatch = url.match(/^\/api\/apps\/([^/]+)\/publish$/);
    if (publishMatch && method === "POST") {
      const id = decodeURIComponent(publishMatch[1]);
      if (initial.publishError) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: initial.publishError }),
        } as Response;
      }
      const card = installed.find((a) => a.id === id);
      return ok({
        appId: id,
        listing: { id, handle: id, slug: id },
        version: {
          version: card?.version ?? "1.0.0",
          contentHash: "c".repeat(64),
          sizeBytes: 1,
        },
        claimed: false,
      });
    }
    const appMatch = url.match(/^\/api\/apps\/([^/]+)$/);
    if (appMatch) {
      const id = decodeURIComponent(appMatch[1]);
      if (method === "DELETE") {
        if (initial.deleteGate) await initial.deleteGate;
        const idx = installed.findIndex((a) => a.id === id);
        if (idx >= 0) installed.splice(idx, 1);
        return ok({ appId: id, purged: false });
      }
    }
    // Settings, public-access, and anything else the page probes on mount.
    return ok({});
  }) as typeof fetch);
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AppsIndexPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {JSON.stringify({ pathname: location.pathname, state: location.state })}
    </div>
  );
}

describe("AppsIndexPage reactivity", () => {
  it("starts an update chat in the app's remembered source project", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({
          id: "weather",
          displayName: "Weather",
          source: { mode: "source", path: "/projects/apps/weather" },
          projectPath: "apps/weather",
        }),
      ],
    });

    renderPage();

    await user.click(await screen.findByLabelText("More actions for Weather"));
    await user.click(await screen.findByRole("menuitem", { name: "Start chat here" }));

    expect(screen.getByTestId("location").textContent).toBe(
      JSON.stringify({ pathname: "/chat", state: { projectPath: "apps/weather" } }),
    );
  });

  it("does not offer an update chat without a remembered source project", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather" })],
    });

    renderPage();

    await user.click(await screen.findByLabelText("More actions for Weather"));
    expect(screen.queryByRole("menuitem", { name: "Start chat here" })).toBeNull();
  });

  it("offers Remix only for an installed Store app whose local manifest includes source", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({
          id: "remixable",
          displayName: "Remixable",
          origin: "appstore",
          source: { mode: "appstore", listingId: "@alice/remixable", version: "1.2.3" },
          includeSource: true,
        }),
        installedCard({
          id: "runtime-only",
          displayName: "Runtime Only",
          origin: "appstore",
          source: { mode: "appstore", listingId: "@alice/runtime-only", version: "1.2.3" },
          includeSource: false,
        }),
        installedCard({
          id: "local-source",
          displayName: "Local Source",
          origin: "local",
          includeSource: true,
        }),
        installedCard({
          id: "still-installing",
          displayName: "Still Installing",
          origin: "appstore",
          phase: "installing",
          source: { mode: "appstore", listingId: "@alice/still-installing", version: "1.2.3" },
          includeSource: true,
        }),
      ],
    });

    renderPage();

    expect(await screen.findAllByText("Remixable")).toHaveLength(1);
    await user.click(screen.getByLabelText("More actions for Remixable"));
    expect(screen.getByRole("menuitem", { name: "Remix…" })).toBeTruthy();

    for (const name of ["Runtime Only", "Local Source", "Still Installing"]) {
      await user.keyboard("{Escape}");
      await user.click(screen.getByLabelText(`More actions for ${name}`));
      expect(screen.queryByRole("menuitem", { name: "Remix…" })).toBeNull();
    }
  });

  it("validates the scoped name and opens Chat with a remix draft plus skill", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({
          id: "calendar",
          displayName: "Calendar",
          origin: "appstore",
          source: { mode: "appstore", listingId: "@alice/calendar", version: "1.2.3" },
          includeSource: true,
        }),
      ],
    });

    renderPage();

    await user.click(await screen.findByLabelText("More actions for Calendar"));
    await user.click(await screen.findByRole("menuitem", { name: "Remix…" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: "New app name" });
    expect((input as HTMLInputElement).value).toBe("@ray/calendar");

    await user.clear(input);
    await user.type(input, "calendar");
    await user.click(within(dialog).getByRole("button", { name: "Continue in chat" }));
    expect(within(dialog).getByText(/Use a scoped name/)).toBeTruthy();

    await user.clear(input);
    await user.type(input, "@ray/calendar");
    await user.click(within(dialog).getByRole("button", { name: "Continue in chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        JSON.stringify({
          pathname: "/chat",
          state: {
            draft:
              "I want to remix the installed app calendar version 1.2.3 as @ray/calendar, with the following changes:\n\n",
            skill: "coding:app_remix",
          },
        }),
      );
    });
  });

  it("omits the built-in chat card from the apps catalog", async () => {
    mockBackend({
      installed: [],
    });

    renderPage();

    expect(await screen.findByText("Projects")).toBeTruthy();
    expect(screen.queryByText("Chat")).toBeNull();
  });

  it("sections apps by origin: my apps, then App Store installs, then built-ins", async () => {
    mockBackend({
      installed: [
        installedCard({
          id: "shipped",
          displayName: "Shipped App",
          origin: "builtin",
          canUninstall: false,
          canPublish: false,
        }),
        installedCard({
          id: "store-app",
          displayName: "Store App",
          origin: "appstore",
          source: { mode: "appstore", listingId: "store-app", version: "1.0.0" },
        }),
        installedCard({
          id: "built-here",
          displayName: "Built Here",
          origin: "local",
          source: { mode: "source", path: "/work/built-here" },
        }),
      ],
    });

    renderPage();

    // Wait for the list to land (sections render skeletons while loading).
    await screen.findByText("Built Here");

    // Each card lands in its provenance section…
    const mySection = screen.getByRole("region", { name: "My apps" });
    const storeSection = screen.getByRole("region", { name: "Installed apps" });
    const builtinSection = screen.getByRole("region", { name: "Built-in apps" });
    expect(within(mySection).getByText("Built Here")).toBeTruthy();
    expect(within(storeSection).getByText("Store App")).toBeTruthy();
    expect(within(builtinSection).getByText("Shipped App")).toBeTruthy();
    // …and built-in surfaces share the built-in section with first-party apps.
    expect(within(builtinSection).getByText("Projects")).toBeTruthy();

    // Section order matches the page contract: my → store → built-in.
    const builtHere = within(mySection).getByText("Built Here");
    const storeApp = within(storeSection).getByText("Store App");
    const shipped = within(builtinSection).getByText("Shipped App");
    expect(
      Boolean(builtHere.compareDocumentPosition(storeApp) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(storeApp.compareDocumentPosition(shipped) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("hides a section that has no matches while searching", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({ id: "weather", displayName: "Weather", origin: "local" }),
        installedCard({
          id: "store-app",
          displayName: "Store App",
          origin: "appstore",
          source: { mode: "appstore", listingId: "store-app", version: "1.0.0" },
        }),
      ],
    });

    renderPage();

    expect(await screen.findByRole("region", { name: "Installed apps" })).toBeTruthy();

    await user.type(screen.getByLabelText("Search apps"), "weath");

    expect(screen.getByRole("region", { name: "My apps" })).toBeTruthy();
    expect(screen.getByText("Weather")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Installed apps" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Built-in apps" })).toBeNull();
  });

  it("drops the update affordance after upgrading (server truth re-read)", async () => {
    const user = userEvent.setup();
    const upgraded = installedCard({
      id: "weather",
      displayName: "Weather",
      version: "1.1.0",
    });
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather" })],
      // The upgraded card carries a version the old card never had — the
      // kebab's plain (no "update available") label can only come back if the
      // page re-reads /api/apps and sees the candidate go stale against it.
      onInstall: () => upgraded,
      upgradable: [
        {
          appId: "weather",
          currentVersion: "1.0.0",
          availableVersion: "1.1.0",
          targetSource: { mode: "bundle", path: "/sources/weather" },
        },
      ],
    });

    renderPage();

    await user.click(
      await screen.findByRole("button", {
        name: "More actions for Weather (update to v1.1.0 available)",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Upgrade → v1\.1\.0/ }));

    expect(await screen.findByLabelText("More actions for Weather")).toBeTruthy();
    expect(screen.queryByLabelText(/update to v1\.1\.0 available/)).toBeNull();
    const appInstallCalls = rs.mocked(globalThis.fetch).mock.calls.filter(([url, init]) => {
      return String(url) === "/api/apps" && init?.method === "POST";
    });
    expect(appInstallCalls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { source: { mode: "bundle", path: "/sources/weather" } },
    ]);
  });

  it("opens the app details page from the card menu", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather" })],
    });

    renderPage();

    await user.click(await screen.findByLabelText("More actions for Weather"));
    await user.click(await screen.findByRole("menuitem", { name: "View details" }));

    expect(screen.getByTestId("location").textContent).toBe(
      JSON.stringify({ pathname: "/app-details/weather", state: null }),
    );
  });

  it("upgrades every fresh update candidate from the header action", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({ id: "weather", displayName: "Weather" }),
        installedCard({ id: "notes", displayName: "Notes" }),
        installedCard({ id: "system", displayName: "System" }),
      ],
      onInstall: (id) =>
        installedCard({
          id,
          displayName: id === "weather" ? "Weather" : "Notes",
          version: id === "weather" ? "1.1.0" : "2.0.0",
        }),
      upgradable: [
        {
          appId: "weather",
          currentVersion: "1.0.0",
          availableVersion: "1.1.0",
          targetSource: { mode: "bundle", path: "/sources/weather" },
        },
        {
          appId: "notes",
          currentVersion: "1.0.0",
          availableVersion: "2.0.0",
          targetSource: { mode: "bundle", path: "/sources/notes" },
        },
      ],
    });

    renderPage();

    const updateAll = await screen.findByRole("button", { name: "Update all" });
    await waitFor(() => expect((updateAll as HTMLButtonElement).disabled).toBe(false));
    await user.click(updateAll);

    await waitFor(() => expect(rs.mocked(toast.success)).toHaveBeenCalledWith("Updated 2 apps."));

    const appInstallCalls = rs.mocked(globalThis.fetch).mock.calls.filter(([url, init]) => {
      return String(url) === "/api/apps" && init?.method === "POST";
    });
    expect(appInstallCalls).toHaveLength(2);
    expect(appInstallCalls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { source: { mode: "bundle", path: "/sources/weather" } },
      { source: { mode: "bundle", path: "/sources/notes" } },
    ]);
    // Both candidates are now stale against the refetched versions, so the
    // header action re-disables — visible only if the list was re-read.
    await waitFor(() => expect((updateAll as HTMLButtonElement).disabled).toBe(true));
  });

  it("removes the card after uninstalling", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "notes", displayName: "Notes" })],
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "More actions for Notes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Uninstall" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));

    await waitFor(() => expect(screen.queryByText("Notes")).toBeNull());
  });

  it("shows 'Uninstalling…' (not 'Installing…') on the card while the uninstall is in flight", async () => {
    const user = userEvent.setup();
    let releaseDelete: () => void = () => {};
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    mockBackend({
      installed: [installedCard({ id: "notes", displayName: "Notes" })],
      deleteGate,
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "More actions for Notes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Uninstall" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));

    // DELETE is held open, so the card stays mounted in its in-flight state.
    expect(await screen.findByText("Uninstalling…")).toBeTruthy();
    expect(screen.queryByText("Installing…")).toBeNull();
    expect(screen.queryByText("Installing...")).toBeNull();

    releaseDelete();
    await waitFor(() => expect(screen.queryByText("Notes")).toBeNull());
  });

  it("offers no uninstall entry for a first-party app (server says canUninstall: false)", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({
          id: "inbox",
          displayName: "Inbox",
          canUninstall: false,
          canPublish: false,
        }),
      ],
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "More actions for Inbox" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "Uninstall" })).toBeNull();
    // Enable/disable stays available — it is the one first-party control.
    expect(screen.getByRole("menuitem", { name: "Disable" })).toBeTruthy();
  });

  it("publishes an app to the store from the card menu after confirming", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "notes", displayName: "Notes" })],
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "More actions for Notes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Publish" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/apps/notes/publish",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    // Success toast, and no error toast, after a successful publish.
    await waitFor(() => expect(rs.mocked(toast.success)).toHaveBeenCalled());
    expect(rs.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("surfaces the store's rejection message as an error toast", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "notes", displayName: "Notes" })],
      publishError: "Version 1.0.0 is not strictly higher than 1.0.0",
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "More actions for Notes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(rs.mocked(toast.error)).toHaveBeenCalledWith(
        "Version 1.0.0 is not strictly higher than 1.0.0",
      ),
    );
  });

  it("offers no publish entry when the server says the app cannot be published", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "system", displayName: "System", canPublish: false })],
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "More actions for System" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "Publish" })).toBeNull();
  });

  it("offers only View details for a card with no lifecycle actions", async () => {
    // The system app's real shape: nothing to upgrade, open, publish, toggle,
    // or uninstall — the menu still renders, holding just the details entry.
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({
          id: "system",
          displayName: "System",
          canPublish: false,
          canToggle: false,
          canUninstall: false,
          canManagePublicAccess: false,
        }),
      ],
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "More actions for System" }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["View details"]);
  });
});

describe("AppsIndexPage tile interactions", () => {
  it("routes a tile without a web UI to the app details page", async () => {
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather" })],
    });

    renderPage();

    const cover = await screen.findByLabelText("View details for Weather");
    expect(cover.getAttribute("href")).toBe("/app-details/weather");
  });

  it("opens the actions menu from a right-click on the tile", async () => {
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather" })],
    });

    renderPage();

    fireEvent.contextMenu(await screen.findByLabelText("View details for Weather"));

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "View details" })).toBeTruthy();
  });

  it("opens the actions menu from a long-press with a touch pointer", async () => {
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather" })],
    });

    renderPage();

    // Press and hold (no pointerup): the menu opens once the long-press timer
    // fires, without activating the tile's cover link.
    fireEvent.pointerDown(await screen.findByLabelText("View details for Weather"), {
      pointerType: "touch",
      clientX: 5,
      clientY: 5,
    });

    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toContain('"pathname":"/"');
  });

  it("toggles a built-in surface's sidebar pin from its tile menu", async () => {
    // Projects starts pinned (it's in DEFAULT_SIDEBAR_PINS), so the menu
    // offers Unpin; activating it drops the entry from the stored pins.
    const user = userEvent.setup();
    mockBackend({ installed: [] });

    renderPage();

    await user.click(await screen.findByLabelText("More actions for Projects"));
    await user.click(await screen.findByRole("menuitem", { name: "Unpin from sidebar" }));

    const stored = JSON.parse(localStorage.getItem("rome-sidebar-pins") ?? "[]");
    expect(stored).not.toContainEqual({ type: "builtin", id: "projects" });
    expect(stored).toContainEqual({ type: "builtin", id: "apps" });
  });
});

describe("AppsIndexPage tile name tooltip", () => {
  // jsdom performs no layout, so scrollWidth/clientWidth are both 0 and the
  // page's "is the label clipped?" probe reads false. Fake the geometry of a
  // clipped label on the name span to exercise the tooltip path.
  function fakeClippedLabel(el: HTMLElement) {
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: 180 });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: 84 });
  }

  it("reveals the full name in a tooltip when hovering a tile whose name is clipped", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "competitor", displayName: "Competitor Analysis Tracker" })],
    });

    renderPage();

    fakeClippedLabel(await screen.findByText("Competitor Analysis Tracker"));
    await user.hover(screen.getByLabelText("View details for Competitor Analysis Tracker"));

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("Competitor Analysis Tracker");
  });

  it("shows no tooltip when the name fits on its line", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "notes", displayName: "Notes" })],
    });

    renderPage();

    // Untouched jsdom geometry (0/0) is exactly a label that fits.
    await screen.findByText("Notes");
    await user.hover(screen.getByLabelText("View details for Notes"));

    // Outwait the tooltip open delay before concluding nothing appeared.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("AppsIndexPage disabled apps", () => {
  it("keeps a disabled app's real icon, desaturated, while an enabled app stays full-color", async () => {
    mockBackend({
      installed: [
        installedCard({
          id: "brief",
          displayName: "Investor Brief",
          status: "disabled",
          isEnabled: false,
          iconUrl: "/api/apps/brief/icon",
        }),
        installedCard({
          id: "notes",
          displayName: "Notes",
          iconUrl: "/api/apps/notes/icon",
        }),
      ],
    });

    const { container } = renderPage();

    await screen.findByText("Investor Brief");
    const disabledIcon = container.querySelector('img[src="/api/apps/brief/icon"]');
    const enabledIcon = container.querySelector('img[src="/api/apps/notes/icon"]');
    expect(disabledIcon?.className).toContain("grayscale");
    expect(enabledIcon?.className).not.toContain("grayscale");
  });
});

describe("AppsIndexPage search", () => {
  it("filters the grid to the apps and built-ins matching the query", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({ id: "weather", displayName: "Weather" }),
        installedCard({ id: "calendar", displayName: "Calendar" }),
      ],
    });

    renderPage();

    expect(await screen.findByText("Weather")).toBeTruthy();
    expect(screen.getByText("Calendar")).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();

    await user.type(screen.getByLabelText("Search apps"), "weath");

    expect(screen.getByText("Weather")).toBeTruthy();
    // Non-matching installed app and built-in surface both drop out.
    expect(screen.queryByText("Calendar")).toBeNull();
    expect(screen.queryByText("Projects")).toBeNull();
  });

  it("derives displayed section and header counts from visible search results", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({ id: "weather", displayName: "Weather", origin: "local" }),
        installedCard({ id: "calendar", displayName: "Calendar", origin: "local" }),
        installedCard({
          id: "store-app",
          displayName: "Store App",
          origin: "appstore",
          source: { mode: "appstore", listingId: "store-app", version: "1.0.0" },
        }),
        installedCard({
          id: "system",
          displayName: "System",
          origin: "builtin",
          canUninstall: false,
          canPublish: false,
        }),
      ],
    });

    renderPage();

    await screen.findByText("Weather");
    await user.type(screen.getByLabelText("Search apps"), "weath");

    expect(screen.getByText("1 built by you")).toBeTruthy();
    expect(screen.getByText("0 installed")).toBeTruthy();
    expect(screen.getByText("0 built-in")).toBeTruthy();

    const mySection = screen.getByRole("region", { name: "My apps" });
    expect(within(mySection).getByText("1")).toBeTruthy();
    expect(within(mySection).getByText("Weather")).toBeTruthy();
    expect(within(mySection).queryByText("Calendar")).toBeNull();
  });

  it("defers the built-in header summary until installed apps have loaded", async () => {
    let releaseApps: () => void = () => {};
    const appsGate = new Promise<void>((resolve) => {
      releaseApps = resolve;
    });
    mockBackend({
      installed: [
        installedCard({
          id: "system",
          displayName: "System",
          origin: "builtin",
          canUninstall: false,
          canPublish: false,
        }),
      ],
      appsGate,
    });

    renderPage();

    expect(screen.queryByText("1 built-in")).toBeNull();
    expect(screen.queryByText("2 built-in")).toBeNull();

    releaseApps();

    expect(await screen.findByText("2 built-in")).toBeTruthy();
  });

  it("shows an empty state for a query with no matches, and clearing restores the grid", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather" })],
    });

    renderPage();

    await user.type(await screen.findByLabelText("Search apps"), "zzzznope");

    const emptyState = screen.getByRole("status");
    expect(within(emptyState).getByText(/No apps match/)).toBeTruthy();
    expect(screen.queryByText("Weather")).toBeNull();

    await user.click(within(emptyState).getByRole("button", { name: "Clear search" }));

    expect(screen.getByText("Weather")).toBeTruthy();
    expect(screen.queryByText(/No apps match/)).toBeNull();
  });

  it("clears the field on Escape, but not while an IME composition is active", async () => {
    const user = userEvent.setup();
    mockBackend({ installed: [installedCard({ id: "weather", displayName: "Weather" })] });

    renderPage();

    const input = (await screen.findByLabelText("Search apps")) as HTMLInputElement;
    await user.type(input, "weather");
    expect(input.value).toBe("weather");

    // Escape mid-composition (CJK IME canceling its candidate buffer) must not
    // wipe the committed query.
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(input.value).toBe("weather");

    // A plain Escape clears it.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });
});

describe("AppsIndexPage ghost tiles", () => {
  it("renders only the ghost tiles in empty sections, with no zero count pills", async () => {
    mockBackend({ installed: [] });

    renderPage();

    expect(await screen.findByRole("button", { name: "New app" })).toBeTruthy();
    const mySection = screen.getByRole("region", { name: "My apps" });
    const storeSection = screen.getByRole("region", { name: "Installed apps" });
    expect(within(storeSection).getByRole("button", { name: "Browse store" })).toBeTruthy();
    // A zero count renders no pill; the non-empty built-in section keeps its.
    expect(within(mySection).queryByText("0")).toBeNull();
    expect(within(storeSection).queryByText("0")).toBeNull();
    const builtinSection = screen.getByRole("region", { name: "Built-in apps" });
    expect(within(builtinSection).getByText("1")).toBeTruthy();
  });

  it("seeds a chat draft from the New app ghost tile", async () => {
    const user = userEvent.setup();
    mockBackend({ installed: [] });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "New app" }));

    expect(screen.getByTestId("location").textContent).toBe(
      JSON.stringify({ pathname: "/chat", state: { draft: "Create a new app that " } }),
    );
  });

  it("opens the App Store sheet from the Browse store ghost tile", async () => {
    const user = userEvent.setup();
    mockBackend({ installed: [] });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "Browse store" }));

    expect(await screen.findByRole("dialog", { name: "App store" })).toBeTruthy();
  });

  it("appends the ghost tile after the real tiles, and hides it while searching", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather", origin: "local" })],
    });

    renderPage();

    const weather = await screen.findByText("Weather");
    const ghost = screen.getByRole("button", { name: "New app" });
    expect(Boolean(weather.compareDocumentPosition(ghost) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );

    await user.type(screen.getByLabelText("Search apps"), "weath");

    expect(screen.getByText("Weather")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New app" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Browse store" })).toBeNull();
  });
});
