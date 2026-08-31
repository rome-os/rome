// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import i18n from "@/i18n";
import SettingsPage from "./SettingsTabPage";

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

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.clearAllMocks();
});

function response(ok: boolean, status: number, json: unknown): Response {
  return {
    ok,
    status,
    json: async () => structuredClone(json),
  } as Response;
}

function defaultResponse(url: string): Response {
  if (url === "/api/tailscale/devices") {
    return response(true, 200, { mode: "oauth", configured: false, devices: [] });
  }
  if (url === "/api/diagnosis") {
    return response(true, 200, {
      status: "ok",
      checkedAt: "2026-08-07T00:00:00.000Z",
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
  return response(true, 200, {});
}

function renderSettings(path = "/settings/advanced") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettingsPage failures", () => {
  it("replaces settings content with the load error and retries the request", async () => {
    let settingsLoads = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") {
        settingsLoads += 1;
        if (settingsLoads === 1) {
          return response(false, 503, { error: "Settings service unavailable" });
        }
        return response(true, 200, {});
      }
      return defaultResponse(url);
    }) as typeof fetch);

    renderSettings();

    expect(await screen.findByText("Settings service unavailable")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Advanced Settings" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("heading", { level: 2, name: "Advanced Settings" }),
    ).toBeTruthy();
    expect(settingsLoads).toBe(2);
  });

  it("shows a save failure toast whose retry action reissues the rejected patch", async () => {
    let putAttempts = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/settings") {
        if (init?.method === "PUT") {
          putAttempts += 1;
          if (putAttempts === 1) {
            return response(false, 500, { error: "Save exploded" });
          }
          return response(true, 200, { success: true });
        }
        return response(true, 200, { enableFable: false });
      }
      return defaultResponse(url);
    }) as typeof fetch);

    renderSettings();
    await userEvent.click(await screen.findByText("Route large models to Fable"));

    await waitFor(() =>
      expect(rs.mocked(toast.error)).toHaveBeenCalledWith(
        "Save exploded",
        expect.objectContaining({
          action: expect.objectContaining({ label: "Retry", onClick: expect.any(Function) }),
        }),
      ),
    );

    const retry = rs.mocked(toast.error).mock.calls[0]?.[1]?.action as { onClick: () => void };
    act(() => retry.onClick());

    await waitFor(() => expect(putAttempts).toBe(2));
    expect(rs.mocked(toast.success)).toHaveBeenCalledWith("Settings saved");
  });
});
