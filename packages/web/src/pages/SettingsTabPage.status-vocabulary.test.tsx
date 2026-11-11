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

// The relay status renders in the diagnosis sheet; the mock shows it inline.
rs.mock("@/components/system-diagnosis-section", () => ({
  SystemDiagnosisSection: ({ details }: { details?: React.ReactNode }) => details,
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

function renderAdvanced(relay: Record<string, unknown> | null) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/settings") return response({});
    if (url === "/api/integrations/relay") return response({ relay });
    if (url === "/api/public-access") {
      return response({ allowedApps: [], cloudEmailAccess: {} });
    }
    if (url === "/api/dashboard-access") return response({ cloudEmailAccess: [] });
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
  const indicator = (await screen.findByText(label)).closest('[data-slot="status-indicator"]');
  expect(indicator?.querySelector('[aria-hidden="true"]')).not.toBeNull();
}

describe("Settings connection status vocabulary", () => {
  it("describes a configured relay that is down as Not connected", async () => {
    renderAdvanced({
      configured: true,
      drainUrl: "https://relay.test/drain",
      depositUrl: "https://relay.test/deposit",
      targetApp: "inbox",
      connected: false,
      error: null,
      connectedSince: null,
      lastEventAt: null,
      deliveredCount: 0,
    });

    await screen.findByRole("heading", { name: "Webhook relay" });
    await expectStatusIndicator("Not connected");
    expect(screen.queryByText("Disconnected")).toBeNull();
  });
});
