// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import SettingsPage from "./SettingsTabPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function ok(json: unknown): Response {
  return { ok: true, status: 200, json: async () => structuredClone(json) } as Response;
}

function mockSettingsBackend() {
  const calls: FetchCall[] = [];
  const settings = {
    sentinelReviewIntervalMinutes: 60,
  };

  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });

    if (url === "/api/settings") {
      if (method === "PUT") {
        Object.assign(settings, body);
        return ok({ success: true });
      }
      return ok(settings);
    }
    if (url === "/api/sentinel-log") return ok([]);
    if (url === "/api/tailscale/devices") {
      return ok({ mode: "oauth", configured: false, devices: [] });
    }
    if (url === "/api/public-access") {
      return ok({ enableAccessControl: false, allowedApps: [] });
    }
    if (url === "/api/dashboard-access") {
      return ok({ cloudEmailAccess: [] });
    }
    if (url === "/api/tailnet") {
      return ok({ tailnetDns: null, httpsEnabled: false, certReady: false });
    }
    if (url === "/api/uptime") return ok({ uptime: 120 });
    if (url === "/api/build-info") return ok({ sha: null, builtAt: null });
    if (url === "/api/diagnosis") {
      return ok({
        status: "ok",
        checkedAt: "2026-06-16T00:00:00.000Z",
        uptimeSeconds: 120,
        build: { version: null, sha: null, builtAt: null },
        upgradedSinceLastBoot: false,
        previousVersion: null,
        instance: { auth: "no_token", accountId: null, instanceId: null },
        database: { ok: true },
        channels: [],
        apps: { total: 0, failed: [], broken: [] },
      });
    }
    return ok({});
  }) as typeof fetch);

  return calls;
}

function renderAdvancedSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings/advanced"]}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderSettingsAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
          <Route path="/apps/inbox" element={<div>Inbox dashboard</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettingsPage Advanced autosave", () => {
  it("uses diagnosis as the single source for uptime and build details", async () => {
    const calls = mockSettingsBackend();
    renderAdvancedSettings();

    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/api/diagnosis")).toHaveLength(1),
    );
    expect(calls.filter((call) => call.url === "/api/uptime")).toHaveLength(0);
    // System Upgrade still needs build-info, but the removed footer must not fetch it again.
    expect(calls.filter((call) => call.url === "/api/build-info")).toHaveLength(1);
  });

  it("does not render the old Session and Sentinel save buttons", async () => {
    mockSettingsBackend();
    renderAdvancedSettings();

    expect(await screen.findByText("Advanced Settings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
  });

  it.each([
    "/settings/trust",
    "/settings/sentinel",
    "/settings/sentinel-log",
  ])("redirects relocated settings route %s to the Inbox page", async (path) => {
    mockSettingsBackend();
    renderSettingsAt(path);

    expect(await screen.findByText("Inbox dashboard")).toBeTruthy();
  });

  it("autosaves the Fable developer setting when changed", async () => {
    const calls = mockSettingsBackend();
    const user = userEvent.setup();
    renderAdvancedSettings();

    await user.click(await screen.findByText("Route large models to Fable"));

    await waitFor(() =>
      expect(calls).toContainEqual({
        url: "/api/settings",
        method: "PUT",
        body: { enableFable: true },
      }),
    );
  });
});
