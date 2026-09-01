// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstalledAppCard } from "@rome/api-types/apps";
import i18n from "@/i18n";
import AppDetailPage from "./AppDetailPage";

// The README renders through the shared markdown pipeline; the details page
// only needs to prove it hands the fetched source over, so stub the renderer.
rs.mock("@/components/markdown", () => ({
  default: ({ children }: { children?: string }) => <div data-testid="markdown">{children}</div>,
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // Radix switch + dialog poke pointer-capture and scrollIntoView, which jsdom omits.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

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
    source: { mode: "bundle", path: "/seeds/x" },
    projectPath: null,
    origin: "local",
    iconUrl: null,
    ...overrides,
  };
}

function mockBackend(initial: {
  installed: InstalledAppCard[];
  readmeByAppId?: Record<string, string | null>;
  /** When set, GET /api/apps fails hard with this status. */
  listFailStatus?: number;
  /** POST /apps replaces the target card with this (upgrade lands server-side). */
  onInstall?: (id: string) => InstalledAppCard;
}) {
  // Mutable server state: PATCH/DELETE/POST change the installed list, so the
  // next GET /api/apps reflects the new truth — what a refetch sees.
  const installed = [...initial.installed];

  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const ok = (json: unknown) =>
      ({ ok: true, status: 200, json: async () => structuredClone(json) }) as Response;

    if (url === "/api/auth/me" && method === "GET") {
      return ok({ kind: "guardian", userId: "ray", displayName: "Ray", avatarUrl: null });
    }
    if (url === "/api/apps" && method === "GET") {
      if (initial.listFailStatus) {
        return {
          ok: false,
          status: initial.listFailStatus,
          json: async () => ({ error: "boom" }),
        } as Response;
      }
      return ok({ apps: installed });
    }
    if (url === "/api/apps" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { source?: { path?: string } };
      const id = body.source?.path?.split("/").pop() ?? "";
      const card = initial.onInstall?.(id);
      const idx = installed.findIndex((a) => a.id === id);
      if (card && idx >= 0) installed.splice(idx, 1, card);
      return ok({ appId: id, spec: { source: body.source, enabled: true }, phase: "installed" });
    }
    const appMatch = url.match(/^\/api\/apps\/([^/]+)$/);
    if (appMatch) {
      const id = decodeURIComponent(appMatch[1]);
      const idx = installed.findIndex((a) => a.id === id);
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean };
        if (idx >= 0) {
          installed.splice(idx, 1, {
            ...installed[idx],
            isEnabled: body.enabled === true,
            status: body.enabled === true ? "active" : "disabled",
          });
        }
        return ok({ appId: id, phase: "installed" });
      }
      if (method === "DELETE") {
        if (idx >= 0) installed.splice(idx, 1);
        return ok({ appId: id, purged: false });
      }
    }
    const readmeMatch = url.match(/^\/api\/app-readmes\/([^/]+)$/);
    if (readmeMatch) {
      const id = decodeURIComponent(readmeMatch[1]);
      return ok({ appId: id, readme: initial.readmeByAppId?.[id] ?? null });
    }
    return ok({});
  }) as typeof fetch);
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {JSON.stringify({ pathname: location.pathname, state: location.state })}
    </div>
  );
}

interface SeedUpgradeCandidate {
  appId: string;
  currentVersion: string;
  availableVersion: string;
  targetSource: { mode: string; path: string };
}

function renderPage(appId: string, options?: { seedUpdates?: SeedUpgradeCandidate[] }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  // The details page never fires the updates probe; a candidate is only
  // visible when a previous apps-grid visit left one in the cache. Seed that.
  if (options?.seedUpdates) {
    client.setQueryData(["apps", "updates"], { upgradable: options.seedUpdates });
  }
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/app-details/${encodeURIComponent(appId)}`]}>
        <Routes>
          <Route path="/app-details/:appId" element={<AppDetailPage />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppDetailPage", () => {
  it("renders the app header and the full artifact inventory", async () => {
    mockBackend({
      installed: [
        installedCard({
          id: "weather",
          displayName: "Weather",
          version: "1.2.0",
          description: "Forecasts for your city.",
          capabilityDetails: {
            agents: [{ name: "forecaster", description: "Predicts weather." }],
            actions: [
              { name: "fetch_forecast", description: "Fetches the forecast." },
              { name: "warn_storm", description: "Sends storm warnings." },
            ],
            skills: [
              {
                name: "broken-skill",
                description: "No description provided.",
                loadError: "SKILL.md could not be read",
              },
            ],
            hooks: [],
          },
        }),
      ],
    });

    renderPage("weather");

    expect(await screen.findByRole("heading", { name: "Weather" })).toBeTruthy();
    expect(screen.getByText("weather · v1.2.0")).toBeTruthy();
    expect(screen.getByText("Forecasts for your city.")).toBeTruthy();

    const agents = screen.getByRole("region", { name: "Agents" });
    expect(within(agents).getByText("forecaster")).toBeTruthy();
    expect(within(agents).getByText("Predicts weather.")).toBeTruthy();

    const actions = screen.getByRole("region", { name: "Actions" });
    expect(within(actions).getByText("2")).toBeTruthy();
    expect(within(actions).getByText("fetch_forecast")).toBeTruthy();
    expect(within(actions).getByText("warn_storm")).toBeTruthy();

    // A declared-but-broken artifact surfaces its diagnostic, not the healthy shape.
    const skills = screen.getByRole("region", { name: "Skills" });
    expect(within(skills).getByText("SKILL.md could not be read")).toBeTruthy();
    expect(within(skills).getByText("Failed to load")).toBeTruthy();

    const hooks = screen.getByRole("region", { name: "Hooks" });
    expect(within(hooks).getByText("No hooks declared.")).toBeTruthy();
  });

  it.each([
    "calendar",
    "@alice/calendar",
  ])("offers Remix for installed source %s and preserves its id", async (sourceId) => {
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({
          id: sourceId,
          displayName: "Calendar",
          version: "1.2.3",
          hasFrontend: true,
          href: `/apps/${encodeURIComponent(sourceId)}`,
          origin: "appstore",
          source: { mode: "appstore", listingId: "@alice/calendar", version: "1.2.3" },
          includeSource: true,
        }),
      ],
    });

    renderPage(sourceId);

    const open = await screen.findByRole("link", { name: "Open" });
    const remix = screen.getByRole("button", { name: "Remix…" });
    expect(remix.parentElement).toBe(open.parentElement);

    await user.click(remix);
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: "New app name" });
    expect((input as HTMLInputElement).value).toBe("@ray/calendar");
    await user.click(within(dialog).getByRole("button", { name: "Continue in chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        JSON.stringify({
          pathname: "/chat",
          state: {
            draft: `I want to remix the installed app ${sourceId} version 1.2.3 as @ray/calendar, with the following changes:\n\n`,
            skill: "coding:app_remix",
          },
        }),
      );
    });
  });

  it("does not offer Remix for a runtime-only Store app", async () => {
    mockBackend({
      installed: [
        installedCard({
          id: "calendar",
          displayName: "Calendar",
          hasFrontend: true,
          href: "/apps/calendar",
          origin: "appstore",
          source: { mode: "appstore", listingId: "@alice/calendar", version: "1.2.3" },
          includeSource: false,
        }),
      ],
    });

    renderPage("calendar");

    await screen.findByRole("link", { name: "Open" });
    expect(screen.queryByRole("button", { name: "Remix…" })).toBeNull();
  });

  it("renders the README when the bundle ships one, and hides the section otherwise", async () => {
    mockBackend({
      installed: [
        installedCard({ id: "weather", displayName: "Weather" }),
        installedCard({ id: "notes", displayName: "Notes" }),
      ],
      readmeByAppId: { weather: "# Weather\n\nForecasts." },
    });

    const { unmount } = renderPage("weather");
    const readmeSection = await screen.findByRole("region", { name: "README" });
    expect(within(readmeSection).getByTestId("markdown").textContent).toBe(
      "# Weather\n\nForecasts.",
    );
    unmount();

    mockBackend({ installed: [installedCard({ id: "notes", displayName: "Notes" })] });
    renderPage("notes");
    await screen.findByRole("heading", { name: "Notes" });
    await waitFor(() =>
      expect(rs.mocked(globalThis.fetch)).toHaveBeenCalledWith(
        "/api/app-readmes/notes",
        expect.anything(),
      ),
    );
    expect(screen.queryByRole("region", { name: "README" })).toBeNull();
  });

  it("starts a chat with the canonical scoped agent id from its row", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [
        installedCard({
          id: "@foo/bar",
          displayName: "Foo Bar",
          capabilityDetails: {
            agents: [{ name: "baz", description: "Handles scoped requests." }],
            actions: [],
            skills: [],
            hooks: [],
          },
        }),
      ],
    });

    renderPage("@foo/bar");

    await user.click(await screen.findByLabelText("Chat with baz"));

    expect(screen.getByTestId("location").textContent).toBe(
      JSON.stringify({
        pathname: "/chat",
        state: {
          agentMention: { appId: "@foo/bar", appLabel: "Foo Bar", agentName: "@foo/bar:baz" },
        },
      }),
    );
  });

  it("shows a not-found message for an app id that is not installed", async () => {
    mockBackend({ installed: [installedCard({ id: "weather", displayName: "Weather" })] });

    renderPage("ghost");

    expect(await screen.findByText("This app is not installed.")).toBeTruthy();
  });

  it("never fires the expensive updates probe", async () => {
    mockBackend({ installed: [installedCard({ id: "weather", displayName: "Weather" })] });

    renderPage("weather");

    await screen.findByRole("heading", { name: "Weather" });
    const urls = rs.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input));
    expect(urls).not.toContain("/api/apps/updates");
  });

  it("shows only the error banner (no perpetual skeleton) when the list load fails hard", async () => {
    mockBackend({ installed: [], listFailStatus: 500 });

    const { container } = renderPage("weather");

    expect(await screen.findByText("boom")).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).toBeNull();
    // Not the not-found copy either — the list never loaded, so we can't say.
    expect(screen.queryByText("This app is not installed.")).toBeNull();
  });
});

describe("AppDetailPage manage section", () => {
  it("renders every applicable lifecycle control as a visible row", async () => {
    mockBackend({
      installed: [
        installedCard({
          id: "weather",
          displayName: "Weather",
          projectPath: "apps/weather",
          canManagePublicAccess: true,
        }),
      ],
    });

    renderPage("weather");

    const manage = await screen.findByRole("region", { name: "Manage" });
    expect(within(manage).getByRole("switch", { name: "Enabled" })).toBeTruthy();
    expect(within(manage).getByRole("button", { name: "Start chat here" })).toBeTruthy();
    expect(within(manage).getByRole("button", { name: "Change" })).toBeTruthy();
    expect(within(manage).getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(within(manage).getByRole("button", { name: "Uninstall" })).toBeTruthy();
    expect(within(manage).getByRole("button", { name: "Uninstall and erase data" })).toBeTruthy();
  });

  it("hides the manage section when no lifecycle action applies", async () => {
    mockBackend({
      installed: [
        installedCard({
          id: "system",
          displayName: "System",
          canToggle: false,
          canUninstall: false,
          canPublish: false,
          canManagePublicAccess: false,
        }),
      ],
    });

    renderPage("system");

    await screen.findByRole("heading", { name: "System" });
    expect(screen.queryByRole("region", { name: "Manage" })).toBeNull();
  });

  it("disables the app from the manage switch and re-reads server truth", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather" })],
    });

    renderPage("weather");

    const enabledSwitch = await screen.findByRole("switch", { name: "Enabled" });
    expect(enabledSwitch.getAttribute("aria-checked")).toBe("true");
    await user.click(enabledSwitch);

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/apps/weather",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    // The fake server flipped the card to disabled; the switch can only
    // reflect that after the page refetches the list.
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
  });

  it("uninstalls after confirming and returns to the apps grid", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather" })],
    });

    renderPage("weather");

    const manage = await screen.findByRole("region", { name: "Manage" });
    await user.click(within(manage).getByRole("button", { name: "Uninstall" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/apps/weather",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain('"pathname":"/apps"'),
    );
  });

  it("shows the cached update banner and upgrades from it, without firing the probe", async () => {
    const user = userEvent.setup();
    mockBackend({
      installed: [installedCard({ id: "weather", displayName: "Weather" })],
      onInstall: (id) => installedCard({ id, displayName: "Weather", version: "1.1.0" }),
    });

    renderPage("weather", {
      seedUpdates: [
        {
          appId: "weather",
          currentVersion: "1.0.0",
          availableVersion: "1.1.0",
          targetSource: { mode: "bundle", path: "/sources/weather" },
        },
      ],
    });

    expect(await screen.findByText("Version 1.1.0 is available.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Update" }));

    // The banner clears once the refetched list shows v1.1.0 (candidate stale).
    expect(await screen.findByText("weather · v1.1.0")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Version 1.1.0 is available.")).toBeNull());

    const urls = rs.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input));
    expect(urls).not.toContain("/api/apps/updates");
  });
});
