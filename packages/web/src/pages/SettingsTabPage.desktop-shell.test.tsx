// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import SettingsPage from "./SettingsTabPage";

// Rendered for real — this suite is about whether it mounts at all.
rs.mock("@/components/system-diagnosis-section", () => ({
  SystemDiagnosisRow: () => null,
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
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    const body =
      url === "/api/public-access"
        ? { allowedApps: [], cloudEmailAccess: {} }
        : url === "/api/dashboard-access"
          ? { cloudEmailAccess: [] }
          : {};
    return { ok: true, status: 200, json: async () => body } as Response;
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

describe("Advanced settings version row", () => {
  it("shows the version row in a browser", async () => {
    renderAdvanced();
    expect(await screen.findByText("Current version")).toBeDefined();
  });

  it("shows it in the Mac app too, whose window is the hosted instance itself", async () => {
    // The Mac app opens the hosted Rome's own origin, so the row's relay to
    // Rome Cloud acts on the instance rendering this page.
    window.rome = {};
    renderAdvanced();

    expect(await screen.findByText("Current version")).toBeDefined();
  });
});
