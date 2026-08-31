// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import SettingsPage from "./SettingsTabPage";

rs.mock("@/components/system-upgrade-section", () => ({
  SystemUpgradeSection: () => null,
}));

rs.mock("@/components/system-diagnosis-section", () => ({
  SystemDiagnosisSection: () => null,
}));

rs.mock("@/hooks/use-tailscale-connect", () => ({
  useTailscaleConnect: () => ({
    authUrl: null,
    connecting: false,
    error: null,
    handleConnect: rs.fn(),
    clearAuthUrl: rs.fn(),
  }),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function response(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => structuredClone(json),
  } as Response;
}

function renderAdvanced(tailscale: Record<string, unknown>, relay: Record<string, unknown> | null) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/settings") return response({});
    if (url === "/api/tailscale/devices") return response(tailscale);
    if (url === "/api/integrations/relay") return response({ relay });
    return response({});
  }) as typeof fetch);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

async function expectStatusIndicator(label: string) {
  const indicator = await screen.findByText(label);
  expect(indicator.querySelector('span[aria-hidden="true"]')).not.toBeNull();
}

describe("Settings connection status vocabulary", () => {
  it.each([
    [{ mode: "daemon", status: "connected", peers: [] }, "Connected"],
    [{ mode: "daemon", status: "authenticating", peers: [] }, "Authenticating"],
  ])("renders the Tailscale daemon status through StatusIndicator", async (tailscale, label) => {
    renderAdvanced(tailscale, null);

    await screen.findByRole("heading", { name: "Tailscale" });
    await expectStatusIndicator(label);
  });

  it("describes Tailscale OAuth without credentials as Not configured", async () => {
    renderAdvanced({ mode: "oauth", configured: false, devices: [] }, null);

    await screen.findByRole("heading", { name: "Tailscale" });
    await expectStatusIndicator("Not configured");
    expect(screen.queryByText("Not Connected")).toBeNull();
  });

  it("describes a stopped Tailscale daemon as Not connected", async () => {
    renderAdvanced({ mode: "daemon", status: "stopped", peers: [] }, null);

    await screen.findByRole("heading", { name: "Tailscale" });
    await expectStatusIndicator("Not connected");
    expect(screen.queryByText("Disconnected")).toBeNull();
  });

  it("describes a configured relay that is down as Not connected", async () => {
    renderAdvanced(
      { mode: "oauth", configured: false, devices: [] },
      {
        configured: true,
        drainUrl: "https://relay.test/drain",
        depositUrl: "https://relay.test/deposit",
        targetApp: "inbox",
        connected: false,
        error: null,
        connectedSince: null,
        lastEventAt: null,
        deliveredCount: 0,
      },
    );

    const developerSettings = await screen.findByText("Developer Settings");
    const details = developerSettings.closest("details");
    expect(details).not.toBeNull();
    (details as HTMLDetailsElement).open = true;
    fireEvent(details as HTMLDetailsElement, new Event("toggle"));

    await screen.findByRole("heading", { name: "Webhook relay" });
    await expectStatusIndicator("Not connected");
    expect(screen.queryByText("Disconnected")).toBeNull();
  });
});
