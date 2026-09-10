// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { setActiveSession } from "./use-free-cells";

beforeEach(() => {
  localStorage.clear();
  setActiveSession("reset");
  setActiveSession(null);
  rs.stubGlobal("fetch", rs.fn().mockResolvedValue(new Response(null, { status: 200 })));
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
  localStorage.clear();
});

describe("tool tabs", () => {
  async function setup() {
    const store = await import("./use-free-cells");
    store.setActiveSession("workspace");
    return { store, ...renderHook(() => store.useFreeCells()) };
  }

  it("opens an empty apps panel and restores it after loading or switching sessions", async () => {
    const { store, result } = await setup();
    act(() => result.current.setToolsCollapsed(false));
    expect(result.current.toolView).toEqual({ activeId: null, collapsed: false, unreadIds: [] });
    rs.mocked(fetch).mockResolvedValueOnce(Response.json({ layout: [] }));
    await act(() => store.loadLayoutForSession("workspace"));
    expect(result.current.toolView.collapsed).toBe(false);
    act(() => store.setActiveSession("other"));
    act(() => store.setActiveSession("workspace"));
    expect(result.current.toolView.collapsed).toBe(false);
    act(() => result.current.setToolsCollapsed(true));
    expect(result.current.toolView.collapsed).toBe(true);
  });

  it("focuses an existing manual tool without replacing its route or id", async () => {
    const { store, result } = await setup();
    act(() => {
      store.autoPlaceApp("notes", "draft", { id: 4 });
    });
    const id = result.current.placements[0].id;
    act(() => result.current.addWidget("app", "notes"));
    expect(result.current.placements).toEqual([
      expect.objectContaining({ id, route: "draft", params: { id: 4 } }),
    ]);
    expect(result.current.toolView).toEqual({ activeId: id, collapsed: false, unreadIds: [] });
    act(() => result.current.addWidget("app", "notes"));
    expect(result.current.placements).toHaveLength(1);
  });

  it("keeps the current view and collapse state when an agent opens a tool", async () => {
    const { store, result } = await setup();
    act(() => result.current.addWidget("projects"));
    const activeId = result.current.toolView.activeId;
    act(() => {
      store.autoPlaceApp("notes");
    });
    expect(result.current.toolView.activeId).toBe(activeId);
    expect(result.current.toolView.unreadIds).toHaveLength(1);
    act(() => result.current.setToolsCollapsed(true));
    act(() => {
      store.autoPlaceApp("calendar");
    });
    expect(result.current.toolView.collapsed).toBe(true);
    expect(result.current.toolView.unreadIds).toHaveLength(2);
  });

  it("navigates an existing app to its root when an explicit root link is opened", async () => {
    const { store, result } = await setup();
    act(() => store.autoPlaceApp("notes", "draft", { id: 4 }, true));
    const previous = result.current.placements[0];
    act(() => result.current.setToolsCollapsed(true));
    act(() => store.autoPlaceApp("notes", undefined, undefined, true));
    const current = result.current.placements[0];
    expect(result.current.placements).toHaveLength(1);
    expect(current).toEqual({
      id: expect.any(String),
      type: "app",
      targetId: "notes",
      order: previous.order,
    });
    expect(current.id).not.toBe(previous.id);
    expect(result.current.toolView).toEqual({
      activeId: current.id,
      collapsed: false,
      unreadIds: [],
    });
  });

  it.each([
    "inactive",
    "collapsed",
  ])("marks repeated passive Projects opens unread while %s without changing the view", async (visibility) => {
    const { store, result } = await setup();
    act(() => store.autoPlaceProjects(true));
    const projects = result.current.placements[0];
    act(() => {
      if (visibility === "inactive") result.current.addWidget("desktop");
      else result.current.setToolsCollapsed(true);
    });
    const before = result.current.toolView;
    act(() => {
      store.autoPlaceProjects();
      store.autoPlaceProjects();
    });
    expect(result.current.placements[0]).toEqual(projects);
    expect(result.current.toolView).toEqual({ ...before, unreadIds: [projects.id] });
    expect(JSON.parse(localStorage.getItem("rome:tool-view:workspace") ?? "null")).toEqual(
      result.current.toolView,
    );
    act(() => store.autoPlaceProjects(true));
    expect(result.current.toolView).toEqual({
      activeId: projects.id,
      collapsed: false,
      unreadIds: [],
    });
  });

  it("does not mark visible Projects updates unread", async () => {
    const { store, result } = await setup();
    act(() => store.autoPlaceProjects(true));
    const projects = result.current.placements[0];
    act(() => {
      store.autoPlaceProjects();
      store.updateProjectsSelection(projects.id, "projects/default/report.md");
    });
    expect(result.current.toolView.unreadIds).toEqual([]);
  });

  it("marks a later file update unread after Projects was read and hidden in the same turn", async () => {
    const { store, result } = await setup();
    act(() => store.autoPlaceProjects(true));
    const projects = result.current.placements[0];
    act(() => {
      store.updateProjectsSelection(projects.id, "projects/default/first.md");
      result.current.addWidget("desktop");
    });
    const before = result.current.toolView;
    act(() => store.updateProjectsSelection(projects.id, "projects/default/second.md"));
    expect(result.current.toolView).toEqual({ ...before, unreadIds: [projects.id] });
  });

  it("selects the right neighbor on close, then the left, and preserves selection on background close", async () => {
    const { result } = await setup();
    act(() => {
      result.current.addWidget("desktop");
      result.current.addWidget("projects");
      result.current.addWidget("app", "notes");
    });
    const [browser, projects, notes] = result.current.placements;
    act(() => result.current.selectTool(projects.id));
    act(() => result.current.removeWidget(projects.id));
    expect(result.current.toolView.activeId).toBe(notes.id);
    act(() => result.current.removeWidget(browser.id));
    expect(result.current.toolView.activeId).toBe(notes.id);
    act(() => result.current.removeWidget(notes.id));
    expect(result.current.toolView).toEqual({ activeId: null, collapsed: false, unreadIds: [] });
  });

  it("restores session selection and collapse state while retaining legacy duplicate views", async () => {
    const { store, result } = await setup();
    localStorage.setItem(
      "rome:free-layout:legacy",
      JSON.stringify([
        { id: "a", type: "desktop", order: 0 },
        { id: "b", type: "desktop", order: 1 },
      ]),
    );
    act(() => store.setActiveSession("legacy"));
    expect(result.current.placements).toHaveLength(2);
    act(() => {
      result.current.selectTool("b");
      result.current.setToolsCollapsed(true);
    });
    act(() => store.setActiveSession("other"));
    act(() => store.setActiveSession("legacy"));
    expect(result.current.toolView).toEqual({ activeId: "b", collapsed: true, unreadIds: [] });
    act(() => result.current.addWidget("desktop"));
    expect(result.current.placements).toHaveLength(2);
    expect(result.current.toolView.activeId).toBe("a");
  });

  it("keeps the active app selected when agent navigation changes its mount id", async () => {
    const { store, result } = await setup();
    act(() => result.current.addWidget("app", "notes"));
    const before = result.current.toolView.activeId;
    act(() => {
      store.autoPlaceApp("notes", "another-page");
    });
    expect(result.current.placements).toHaveLength(1);
    expect(result.current.toolView.activeId).not.toBe(before);
    expect(result.current.toolView.activeId).toBe(result.current.placements[0].id);
    expect(result.current.toolView.collapsed).toBe(false);
  });

  it("carries selected tools from a draft into its created session", async () => {
    const { store, result } = await setup();
    act(() => store.setActiveSession(null));
    act(() => result.current.addWidget("desktop"));
    const activeId = result.current.toolView.activeId;
    act(() => store.setActiveSession("created"));
    expect(result.current.toolView.activeId).toBe(activeId);
    expect(result.current.toolView.collapsed).toBe(false);
    expect(JSON.parse(localStorage.getItem("rome:tool-view:created") ?? "null").activeId).toBe(
      activeId,
    );
  });

  it("does not let a delayed layout load erase a newly opened tool", async () => {
    const { store, result } = await setup();
    let respond!: (response: Response) => void;
    rs.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const loading = store.loadLayoutForSession("workspace");
    act(() => result.current.addWidget("desktop"));
    await act(async () => {
      respond(Response.json({ layout: [] }));
      await loading;
    });
    expect(result.current.placements).toHaveLength(1);
    expect(result.current.toolView.collapsed).toBe(false);
  });
});

describe("placeWidgetsIfSessionActive", () => {
  it("does not apply a delayed widget handoff after the active session changes", async () => {
    const { placeWidgetsIfSessionActive, setActiveSession } = await import("./use-free-cells");

    setActiveSession("chat-a");
    setActiveSession("chat-b");

    expect(
      placeWidgetsIfSessionActive("chat-a", [
        { type: "app", appId: "nav-chat-probe", route: "from-chat-a" },
      ]),
    ).toBe(false);

    expect(localStorage.getItem("rome:free-layout:chat-b")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies a widget handoff when the target session is still active", async () => {
    const { placeWidgetsIfSessionActive, setActiveSession } = await import("./use-free-cells");

    setActiveSession("chat-a");

    expect(
      placeWidgetsIfSessionActive("chat-a", [
        { type: "app", appId: "nav-chat-probe", route: "from-chat-a" },
      ]),
    ).toBe(true);

    const layout = JSON.parse(localStorage.getItem("rome:free-layout:chat-a") ?? "[]") as Array<{
      targetId?: string;
      route?: string;
    }>;
    expect(layout).toEqual([
      expect.objectContaining({
        targetId: "nav-chat-probe",
        route: "from-chat-a",
      }),
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/chat/sessions/chat-a/layout",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

describe("placeChatWidget", () => {
  it("places a pinned chat card once per session, keeping the placement id", async () => {
    const { placeChatWidget, setActiveSession } = await import("./use-free-cells");

    setActiveSession("layout-session");
    placeChatWidget("branch-1");

    const read = () =>
      JSON.parse(localStorage.getItem("rome:free-layout:layout-session") ?? "[]") as Array<{
        id: string;
        type: string;
        targetId?: string;
      }>;
    const layout = read();
    expect(layout).toEqual([expect.objectContaining({ type: "chat", targetId: "branch-1" })]);

    // Re-placing the same session is a no-op with a stable id — a fresh id
    // would remount the card and tear down its live stream.
    placeChatWidget("branch-1");
    const again = read();
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(layout[0].id);

    // A different session gets its own card.
    placeChatWidget("branch-2");
    expect(read()).toHaveLength(2);
  });
});
