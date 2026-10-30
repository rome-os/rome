// @rstest-environment jsdom
import { Activity, useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { SlotProvider } from "@/components/slot";
import { FreeGrid } from "./FreeGrid";
import { setActiveSession } from "./use-free-cells";
import type { ToolView, WidgetPlacement } from "./use-free-cells";
import { useWorkspaceContextRegistry } from "./workspace-context";

const seen = rs.hoisted(() => ({
  renders: [] as Array<{ ids: string[]; collapsed: boolean }>,
  location: "/full/apps/notes/new-route",
  mounted: [] as string[],
}));

rs.mock("@/hooks/use-apps", () => ({ useApps: () => ({ apps: [] }) }));
rs.mock("@/components/chat/use-session-identity", () => ({
  useSessionIdentity: () => ({ sessionName: null }),
}));
rs.mock("@/components/chat/Chat", () => ({ Chat: () => null }));
// Records what each render hands the tool pane.
rs.mock("./ToolWorkspace", () => ({
  COMPACT_WIDTH: 640,
  ToolWorkspace: (props: {
    placements: WidgetPlacement[];
    view: ToolView;
    content: (widget: WidgetPlacement, dragging: boolean) => React.ReactNode;
    children: React.ReactNode;
  }) => {
    seen.renders.push({ ids: props.placements.map((p) => p.id), collapsed: props.view.collapsed });
    return (
      <div>
        {props.placements.map((p) => (
          <div key={p.id}>{props.content(p, false)}</div>
        ))}
        {props.children}
      </div>
    );
  },
}));
// A tile whose iframe sits at `seen.location`, registered the way the real one registers.
rs.mock("./AppWidget", () => ({
  AppWidget: ({ placementId }: { placementId: string }) => {
    const registry = useWorkspaceContextRegistry();
    useEffect(() => {
      seen.mounted.push(placementId);
      const iframe = {
        contentWindow: { location: { href: `http://localhost${seen.location}` } },
      } as unknown as HTMLIFrameElement;
      registry?.registerApp(placementId, "notes", iframe);
      return () => registry?.registerApp(placementId, "notes", null);
    }, [placementId, registry]);
    return <iframe title="tile" />;
  },
}));

const layoutKey = (id: string) => `rome:free-layout:${id}`;
const tile = (route?: string): WidgetPlacement[] => [
  { id: "t1", type: "app", targetId: "notes", order: 0, ...(route ? { route } : {}) },
];

function Grid({ mode }: { mode: "visible" | "hidden" }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/settings"]}>
      <QueryClientProvider client={client}>
        <SlotProvider>
          <Activity mode={mode}>
            <FreeGrid sessionId="concierge" active={mode === "visible"} />
          </Activity>
        </SlotProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  seen.renders.length = 0;
  seen.mounted.length = 0;
  localStorage.clear();
  setActiveSession("reset");
  setActiveSession(null);
  rs.stubGlobal(
    "fetch",
    rs.fn(() => Promise.resolve(Response.json([]))),
  );
  rs.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
  localStorage.clear();
});

describe("a Concierge grid shown again while the store holds another chat", () => {
  it("draws neither that chat's tiles nor its expanded pane before its own effect runs", async () => {
    localStorage.setItem(layoutKey("other"), JSON.stringify(tile()));
    localStorage.setItem(
      "rome:tool-view:other",
      JSON.stringify({ activeId: "t1", collapsed: false, unreadIds: [] }),
    );
    const view = render(<Grid mode="visible" />);
    await waitFor(() => expect(seen.renders.length).toBeGreaterThan(0));
    view.rerender(<Grid mode="hidden" />);
    // The chat on screen now holds the store, as its grid's effect does.
    act(() => setActiveSession("other"));
    seen.renders.length = 0;
    seen.mounted.length = 0;

    view.rerender(<Grid mode="visible" />);

    await waitFor(() => expect(seen.renders.length).toBeGreaterThan(0));
    expect(seen.renders.every((render) => render.ids.length === 0 && render.collapsed)).toBe(true);
    expect(seen.mounted).toEqual([]);
  });
});

describe("a grid whose tiles navigated inside their apps", () => {
  const storedRoute = () =>
    JSON.parse(localStorage.getItem(layoutKey("concierge")) ?? "[]")[0]?.route;

  it("saves their locations as an Activity hides it", async () => {
    localStorage.setItem(layoutKey("concierge"), JSON.stringify(tile("old-route")));
    const view = render(<Grid mode="visible" />);
    await waitFor(() => expect(seen.mounted).toEqual(["t1"]));
    expect(storedRoute()).toBe("old-route");

    view.rerender(<Grid mode="hidden" />);

    expect(storedRoute()).toBe("new-route");
  });

  it("saves their locations as the grid goes away", async () => {
    localStorage.setItem(layoutKey("concierge"), JSON.stringify(tile("old-route")));
    const view = render(<Grid mode="visible" />);
    await waitFor(() => expect(seen.mounted).toEqual(["t1"]));

    view.unmount();

    expect(storedRoute()).toBe("new-route");
  });
});
