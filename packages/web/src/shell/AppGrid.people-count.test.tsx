// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { AppGrid, STORAGE_KEY } from "./AppGrid";

// The pending pairing requests are the only thing under test, so every other
// sidebar hook is a fixed stand-in, built once for the same reason
// `AppGrid.store-entry.test.tsx` gives.
const pending = { rows: [] as unknown[] };
rs.mock("@/hooks/use-approvals", () => ({ usePendingPairings: () => pending }));
rs.mock("@/hooks/use-apps", () => {
  const apps: never[] = [];
  const invalidators = { list: async () => {}, updates: async () => {} };
  return { useApps: () => ({ apps }), useInvalidateApps: () => invalidators };
});
rs.mock("@/lib/auth-state", () => ({
  useAuthStateSnapshot: () => ({ bootstrap: { phase: "ready" } }),
  hasSession: () => true,
}));
rs.mock("@/hooks/use-settings", () => {
  const settings = { data: undefined };
  const invalidate = async () => {};
  return { useSettings: () => settings, useInvalidateSettings: () => invalidate };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ type: "builtin", id: "people" }]));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  pending.rows = [];
});

function renderSidebar(collapsed: boolean) {
  return render(
    <MemoryRouter>
      <AppGrid collapsed={collapsed} />
    </MemoryRouter>,
  );
}

describe("People's pairing count in the sidebar", () => {
  it("names the waiting requests on the expanded row", () => {
    pending.rows = [{}, {}];
    renderSidebar(false);
    expect(screen.getByRole("link", { name: "People, 2 pairing requests" })).toBeTruthy();
  });

  it("names the waiting requests on the rail tile", () => {
    pending.rows = [{}];
    renderSidebar(true);
    expect(screen.getByRole("link", { name: "People, 1 pairing request" })).toBeTruthy();
  });

  it("carries no count while nothing waits", () => {
    renderSidebar(false);
    expect(screen.getByRole("link", { name: "People" })).toBeTruthy();
  });
});
