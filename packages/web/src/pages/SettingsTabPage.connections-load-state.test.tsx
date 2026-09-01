// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import SettingsPage from "./SettingsTabPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function ok(json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function failed(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockConnectionsFetch(
  loadConnections: () => Response | Promise<Response>,
): ReturnType<typeof rs.spyOn> {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/settings") return ok({});
    if (url === "/api/tailscale/devices") {
      return ok({ mode: "oauth", configured: false, devices: [] });
    }
    if (url === "/api/integrations/composio/status") return ok({});
    if (url === "/api/connections") return loadConnections();
    return ok({});
  }) as typeof fetch);
}

function renderConnectionsSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings/connections"]}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Settings connections request states", () => {
  it("shows connection row skeletons while the registry request is pending", async () => {
    mockConnectionsFetch(() => new Promise<Response>(() => {}));

    renderConnectionsSettings();

    expect(await screen.findByRole("heading", { level: 2, name: "Connections" })).toBeTruthy();
    expect(screen.getByLabelText("Loading connections")).toBeTruthy();
  });

  it("shows a failed registry request with a retry that reloads the connections", async () => {
    let connectionLoads = 0;
    rs.spyOn(console, "error").mockImplementation(() => {});
    mockConnectionsFetch(() => {
      connectionLoads += 1;
      if (connectionLoads === 1) return failed(503, "Connections service unavailable");
      return ok({
        connections: [
          {
            id: "conn-webchat",
            service: "webchat",
            label: "Webchat",
            grants: {},
            display: {},
            capabilities: {
              talk: { state: "unsupported" },
              act: { state: "unsupported" },
              watch: { state: "unsupported" },
            },
            connect: null,
          },
        ],
      });
    });

    renderConnectionsSettings();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Connections service unavailable")).toBeTruthy();

    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Open Webchat" })).toBeTruthy();
    expect(connectionLoads).toBe(2);
  });

  it("shows a real empty state when the registry request succeeds without connections", async () => {
    mockConnectionsFetch(() => ok({ connections: [] }));

    renderConnectionsSettings();

    expect(await screen.findByText("No connections available")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
