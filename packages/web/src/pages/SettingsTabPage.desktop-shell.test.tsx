// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import SettingsPage from "./SettingsTabPage";

// Rendered for real — this suite is about whether it mounts at all.
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
  Reflect.deleteProperty(window, "rome");
});

function renderAdvanced() {
  rs.spyOn(globalThis, "fetch").mockImplementation(
    (async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response) as typeof fetch,
  );

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

describe("Advanced settings inside the Mac app", () => {
  it("shows the System section in a browser", async () => {
    renderAdvanced();
    expect(await screen.findByRole("heading", { name: "System" })).toBeDefined();
  });

  it("omits it when the desktop preload has exposed its bridge", async () => {
    // The section relays to Rome Cloud, which answers for the account's hosted
    // instance rather than the Mac showing the page.
    window.rome = {};
    renderAdvanced();

    // Wait for a sibling that is not gated, so the assertion cannot pass just
    // because the tab has not rendered yet.
    expect(await screen.findByRole("heading", { name: "Advanced Settings" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "System" })).toBeNull();
  });

  it("still shows it when only the late-arriving class is present", async () => {
    // The class lands on DOMContentLoaded, which a render can precede. Gating
    // on it would fail open with no way back, since nothing re-renders when it
    // appears. This asserts the gate does not depend on it — the bridge is the
    // signal, and here it is absent, so this is a browser.
    document.documentElement.classList.add("is-electron");
    renderAdvanced();
    expect(await screen.findByRole("heading", { name: "System" })).toBeDefined();
  });
});
