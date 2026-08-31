// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import { isPresentationMode } from "@/lib/presentation-mode";
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
  window.localStorage.clear();
});

interface FetchCall {
  url: string;
  method: string;
}

function ok(json: unknown): Response {
  return { ok: true, status: 200, json: async () => structuredClone(json) } as Response;
}

function mockSettingsBackend() {
  const calls: FetchCall[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (url === "/api/settings") return ok({});
    if (url === "/api/tailscale/devices") {
      return ok({ mode: "oauth", configured: false, devices: [] });
    }
    if (url === "/api/public-access") {
      return ok({ enableAccessControl: false, allowedApps: [] });
    }
    if (url === "/api/dashboard-access") return ok({ cloudEmailAccess: [] });
    if (url === "/api/tailnet") {
      return ok({ tailnetDns: null, httpsEnabled: false, certReady: false });
    }
    if (url === "/api/build-info") return ok({ sha: null, builtAt: null });
    if (url === "/api/diagnosis") {
      return ok({
        status: "ok",
        checkedAt: "2026-08-11T00:00:00.000Z",
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

describe("SettingsPage Advanced presentation mode", () => {
  it("toggles the per-browser flag without writing to /api/settings", async () => {
    const calls = mockSettingsBackend();
    const user = userEvent.setup();
    renderAdvancedSettings();

    const toggle = await screen.findByRole("switch", { name: "Mask agent identity in chat" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(isPresentationMode()).toBe(false);

    await user.click(toggle);
    await waitFor(() => expect(isPresentationMode()).toBe(true));
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await user.click(toggle);
    await waitFor(() => expect(isPresentationMode()).toBe(false));

    // Presentation mode is a browser-local preference — it must never reach
    // the server settings store.
    expect(calls.filter((c) => c.url === "/api/settings" && c.method === "PUT")).toHaveLength(0);
  });

  it("renders as on when the flag was already set", async () => {
    window.localStorage.setItem("rome-presentation-mode", "1");
    mockSettingsBackend();
    renderAdvancedSettings();

    const toggle = await screen.findByRole("switch", { name: "Mask agent identity in chat" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
