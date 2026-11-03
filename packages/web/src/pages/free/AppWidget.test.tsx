// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { WorkspaceContextChips } from "@/components/chat/composer/WorkspaceContextChips";
import { AppWidget } from "./AppWidget";
import {
  createWorkspaceContextRegistry,
  WorkspaceContextRegistryContext,
} from "./workspace-context";

const catalog = rs.hoisted(() => ({
  apps: null as { id: string; displayName: string }[] | null,
}));
rs.mock("@/hooks/use-apps", () => ({ useApps: () => ({ apps: catalog.apps }) }));
rs.mock("@/lib/analytics", () => ({ trackWidgetRender: rs.fn() }));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  catalog.apps = null;
});
afterEach(cleanup);

function renderWorkspace() {
  const registry = createWorkspaceContextRegistry();
  const content = () => (
    <WorkspaceContextRegistryContext.Provider value={registry}>
      <AppWidget appId="notes" placementId="placement-1" dragging={false} />
      <WorkspaceContextChips />
    </WorkspaceContextRegistryContext.Provider>
  );
  const view = render(content());
  return { ...view, refresh: () => view.rerender(content()) };
}

describe("workspace app names", () => {
  it("replaces generic frame and chip labels without remounting the iframe", () => {
    const view = renderWorkspace();
    const iframe = screen.getByTitle("Apps");
    expect(screen.getByText("Apps")).toBeTruthy();
    expect(screen.queryByText("notes")).toBeNull();

    catalog.apps = [{ id: "notes", displayName: "Personal Notes" }];
    view.refresh();
    expect(screen.getByTitle("Personal Notes")).toBe(iframe);
    expect(screen.getByText("Personal Notes")).toBeTruthy();

    // A cached catalog stays usable during refetches and refetch errors.
    view.refresh();
    expect(screen.getByTitle("Personal Notes")).toBe(iframe);
    expect(screen.getByText("Personal Notes")).toBeTruthy();
  });

  it("keeps generic labels when the initial catalog request has no data", () => {
    const view = renderWorkspace();
    view.refresh();
    expect(screen.getByTitle("Apps")).toBeTruthy();
    expect(screen.getByText("Apps")).toBeTruthy();
    expect(screen.queryByText("notes")).toBeNull();
  });

  it("uses the id only after a loaded catalog confirms the app is absent", () => {
    const view = renderWorkspace();
    catalog.apps = [];
    view.refresh();
    expect(screen.getByTitle("notes")).toBeTruthy();
    expect(screen.getByText("notes")).toBeTruthy();
  });
});
