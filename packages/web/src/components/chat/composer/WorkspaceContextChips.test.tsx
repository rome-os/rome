// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import {
  createWorkspaceContextRegistry,
  WorkspaceContextRegistryContext,
} from "@/pages/free/workspace-context";
import { setActiveSession, type WidgetPlacement } from "@/pages/free/use-free-cells";
import { WorkspaceContextChips } from "./WorkspaceContextChips";

let sessionSequence = 0;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/apps") {
      return Response.json({
        apps: [
          { id: "shown-app", displayName: "Shown App", iconUrl: null },
          { id: "other-app", displayName: "Other App", iconUrl: null },
        ],
      });
    }
    if (url === "/api/apps/updates") return Response.json({ upgradable: [] });
    return Response.json({}, { status: 404 });
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setActiveSession(null);
  rs.restoreAllMocks();
});

const APP_PLACEMENTS: WidgetPlacement[] = [
  { id: "shown-placement", type: "app", targetId: "shown-app", order: 1 },
  { id: "duplicate-placement", type: "app", targetId: "shown-app", order: 2 },
  { id: "other-placement", type: "app", targetId: "other-app", order: 3 },
];

function renderChips({
  collapsed,
  activeId = "shown-placement",
  placements = APP_PLACEMENTS,
}: {
  collapsed: boolean;
  activeId?: string;
  placements?: WidgetPlacement[];
}) {
  const sessionId = `workspace-context-chips-${sessionSequence++}`;
  localStorage.setItem(`rome:free-layout:${sessionId}`, JSON.stringify(placements));
  localStorage.setItem(
    `rome:tool-view:${sessionId}`,
    JSON.stringify({ activeId, collapsed, unreadIds: [] }),
  );
  setActiveSession(sessionId);

  const registry = createWorkspaceContextRegistry();
  for (const placement of placements) {
    if (placement.type === "app" && placement.targetId) {
      registry.registerApp(placement.id, placement.targetId, document.createElement("iframe"));
    }
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceContextRegistryContext.Provider value={registry}>
        <WorkspaceContextChips />
      </WorkspaceContextRegistryContext.Provider>
    </QueryClientProvider>,
  );
}

describe("WorkspaceContextChips", () => {
  it("omits only the active app placement while preserving a duplicate placement", async () => {
    renderChips({ collapsed: false });

    expect(await screen.findByText("Other App")).toBeTruthy();
    expect(await screen.findAllByText("Shown App")).toHaveLength(1);
  });

  it("keeps the active app in the composer when the tools sidebar is collapsed", async () => {
    renderChips({ collapsed: true });

    expect(await screen.findAllByText("Shown App")).toHaveLength(2);
    expect(await screen.findByText("Other App")).toBeTruthy();
  });

  it("keeps every app placement when the active sidebar tab is not an app", async () => {
    const projectsPlacement: WidgetPlacement = {
      id: "projects-placement",
      type: "projects",
      order: 0,
    };
    renderChips({
      collapsed: false,
      activeId: projectsPlacement.id,
      placements: [projectsPlacement, ...APP_PLACEMENTS],
    });

    expect(await screen.findAllByText("Shown App")).toHaveLength(2);
    expect(await screen.findByText("Other App")).toBeTruthy();
  });
});
