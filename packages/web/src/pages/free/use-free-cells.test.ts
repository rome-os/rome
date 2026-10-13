// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, renderHook } from "@testing-library/react";

beforeEach(async () => {
  localStorage.clear();
  // Imported per test because a test may reset the module registry.
  const { setActiveSession } = await import("./use-free-cells");
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

  it("keeps the panel collapsed with the handed-off tab unread when chat comes first", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("chat-a");
    const { result } = renderHook(() => store.useFreeCells());
    act(() => result.current.addWidget("projects"));
    expect(result.current.toolView.collapsed).toBe(false);

    act(() => {
      store.placeWidgetsIfSessionActive("chat-a", [{ type: "app", appId: "nav-chat-probe" }], {
        chatFirst: true,
      });
    });

    const app = result.current.placements.find((p) => p.targetId === "nav-chat-probe");
    expect(result.current.toolView).toEqual({
      activeId: app?.id,
      collapsed: true,
      unreadIds: [app?.id],
    });

    act(() => result.current.setToolsCollapsed(false));
    expect(result.current.toolView).toEqual({
      activeId: app?.id,
      collapsed: false,
      unreadIds: [],
    });
  });

  it("expands the panel on the handed-off tab by default", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("chat-a");
    const { result } = renderHook(() => store.useFreeCells());

    act(() => {
      store.placeWidgetsIfSessionActive("chat-a", [{ type: "app", appId: "nav-chat-probe" }]);
    });

    const app = result.current.placements.find((p) => p.targetId === "nav-chat-probe");
    expect(result.current.toolView).toEqual({
      activeId: app?.id,
      collapsed: false,
      unreadIds: [],
    });
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

describe("applyAgentPlacement", () => {
  const readLayout = (sessionId: string) =>
    JSON.parse(localStorage.getItem(`rome:free-layout:${sessionId}`) ?? "[]") as Array<{
      id: string;
      targetId?: string;
      route?: string;
    }>;

  it("skips a replayed placement the layout already applied, keeping in-widget navigation", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("replay-chat");

    store.applyAgentPlacement("replay-p1", "notes", "list");
    const [placed] = readLayout("replay-chat");
    store.updatePlacementLink(placed!.id, "detail", undefined);

    store.applyAgentPlacement("replay-p1", "notes", "list");
    expect(readLayout("replay-chat")).toEqual([
      expect.objectContaining({ id: placed!.id, targetId: "notes", route: "detail" }),
    ]);

    // A new placement of the same route is a live re-placement and retargets.
    store.applyAgentPlacement("replay-p2", "notes", "list");
    expect(readLayout("replay-chat")).toEqual([
      expect.objectContaining({ targetId: "notes", route: "list" }),
    ]);
    expect(readLayout("replay-chat")[0]!.id).not.toBe(placed!.id);
  });

  it("places a replay again when a layout load dropped the tile it mounted", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("hydrate-chat");
    store.applyAgentPlacement("hydrate-p1", "notes", "list");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The server then holds a layout saved on another device without the tile.
    rs.mocked(fetch).mockResolvedValueOnce(Response.json({ layout: [] }));
    await store.loadLayoutForSession("hydrate-chat");
    expect(readLayout("hydrate-chat")).toEqual([]);

    store.applyAgentPlacement("hydrate-p1", "notes", "list");
    expect(readLayout("hydrate-chat")).toEqual([
      expect.objectContaining({ targetId: "notes", route: "list" }),
    ]);
  });

  it("applies a placement without an id every time", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("legacy-chat");

    store.applyAgentPlacement(undefined, "notes", "list");
    const [first] = readLayout("legacy-chat");
    store.applyAgentPlacement(undefined, "notes", "list");
    expect(readLayout("legacy-chat")[0]!.id).not.toBe(first!.id);
  });

  it("applies a placement to a session's layout even after another layout applied it", async () => {
    const store = await import("./use-free-cells");
    // A pinned chat's turn places into the open workspace, then the guardian
    // opens that chat while its turn still runs and the stream replays.
    store.setActiveSession("workspace-a");
    store.applyAgentPlacement("cross-p1", "notes", "list");
    store.setActiveSession("pinned-b");
    store.applyAgentPlacement("cross-p1", "notes", "list");

    expect(readLayout("workspace-a")).toEqual([expect.objectContaining({ targetId: "notes" })]);
    expect(readLayout("pinned-b")).toEqual([
      expect.objectContaining({ targetId: "notes", route: "list" }),
    ]);
  });
});

describe("layout sync", () => {
  const readLayout = (sessionId: string) =>
    JSON.parse(localStorage.getItem(`rome:free-layout:${sessionId}`) ?? "[]") as unknown[];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const puts = () =>
    rs
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "PUT")
      .map(([url, init]) => ({ url, layout: JSON.parse(String(init?.body)).layout }));
  // Answers GET with `serverLayout` and accepts every PUT.
  const serve = (serverLayout: unknown[]) =>
    rs
      .mocked(fetch)
      .mockImplementation(async (_url, init) =>
        init?.method === "PUT"
          ? new Response(null, { status: 200 })
          : Response.json({ layout: serverLayout }),
      );

  it.each([
    ["the request is rejected", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["the server answers 500", () => Promise.resolve(new Response(null, { status: 500 }))],
  ])("keeps and resends an edit whose save failed when %s", async (_case, failure) => {
    const store = await import("./use-free-cells");
    const { result } = renderHook(() => store.useFreeCells());
    act(() => store.setActiveSession("offline-chat"));
    rs.mocked(fetch).mockImplementationOnce(failure);
    act(() => result.current.addWidget("app", "notes"));
    await settle();
    const local = readLayout("offline-chat");

    act(() => store.setActiveSession("other-chat"));
    act(() => store.setActiveSession("offline-chat"));
    rs.mocked(fetch).mockClear();
    serve([]);
    await act(() => store.loadLayoutForSession("offline-chat"));

    expect(result.current.placements).toEqual(local);
    expect(readLayout("offline-chat")).toEqual(local);
    expect(puts()).toEqual([{ url: "/api/chat/sessions/offline-chat/layout", layout: local }]);
  });

  it("applies the server copy again once a resent save succeeds", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("retry-chat");
    rs.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    store.autoPlaceApp("notes");
    await settle();
    serve([]);
    await store.loadLayoutForSession("retry-chat");
    await settle();

    const fromOtherDevice = [{ id: "d", type: "desktop", order: 1 }];
    serve(fromOtherDevice);
    await store.loadLayoutForSession("retry-chat");
    expect(readLayout("retry-chat")).toEqual(fromOtherDevice);
  });

  it("sends one save at a time and keeps the local copy until the newest save lands", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("busy-chat");
    let respond!: (response: Response) => void;
    rs.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    store.autoPlaceApp("notes");
    store.autoPlaceProjects();
    store.autoPlaceApp("calendar");
    expect(puts()).toHaveLength(1);

    rs.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    respond(new Response(null, { status: 200 }));
    await settle();
    const sent = puts();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.layout).toEqual(readLayout("busy-chat"));

    // The first save succeeded but the newest failed, so the server's copy is
    // still older than the local one.
    serve(sent[0]!.layout);
    await store.loadLayoutForSession("busy-chat");
    expect(readLayout("busy-chat")).toHaveLength(3);
  });

  it("keeps the marker when another tab stored a newer layout during a save", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("shared-chat");
    let respond!: (response: Response) => void;
    rs.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    store.autoPlaceApp("notes");

    // Another tab stores a newer layout, and its own save fails.
    const fromOtherTab = [{ id: "t", type: "desktop", order: 1 }];
    localStorage.setItem("rome:free-layout:shared-chat", JSON.stringify(fromOtherTab));
    respond(new Response(null, { status: 200 }));
    await settle();

    rs.mocked(fetch).mockClear();
    serve([]);
    await store.loadLayoutForSession("shared-chat");
    expect(readLayout("shared-chat")).toEqual(fromOtherTab);
    expect(puts()).toEqual([
      { url: "/api/chat/sessions/shared-chat/layout", layout: fromOtherTab },
    ]);
  });

  it("resends a newer layout another tab saved before this tab's save landed", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("race-chat");
    let respond!: (response: Response) => void;
    rs.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    store.autoPlaceApp("notes");

    // Another tab stores a newer layout and its save lands first, clearing the
    // marker. This tab's older save then overwrites it on the server.
    const fromOtherTab = [{ id: "t", type: "desktop", order: 1 }];
    localStorage.setItem("rome:free-layout:race-chat", JSON.stringify(fromOtherTab));
    localStorage.removeItem("rome:free-layout-unsynced:race-chat");
    const sent = puts()[0]!.layout;
    respond(new Response(null, { status: 200 }));
    await settle();

    rs.mocked(fetch).mockClear();
    serve(sent);
    await store.loadLayoutForSession("race-chat");
    expect(readLayout("race-chat")).toEqual(fromOtherTab);
    expect(puts()).toEqual([{ url: "/api/chat/sessions/race-chat/layout", layout: fromOtherTab }]);
  });

  it("keeps an edit another tab stored during a load whose save failed", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("slow-chat");
    let respond!: (response: Response) => void;
    rs.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const load = store.loadLayoutForSession("slow-chat");

    // Another tab stores an edit while the GET is in flight, and its save fails.
    const fromOtherTab = [{ id: "t", type: "desktop", order: 1 }];
    localStorage.setItem("rome:free-layout:slow-chat", JSON.stringify(fromOtherTab));
    localStorage.setItem("rome:free-layout-unsynced:slow-chat", "1");
    respond(Response.json({ layout: [] }));
    await load;
    expect(readLayout("slow-chat")).toEqual(fromOtherTab);

    rs.mocked(fetch).mockClear();
    serve([]);
    await store.loadLayoutForSession("slow-chat");
    expect(puts()).toEqual([{ url: "/api/chat/sessions/slow-chat/layout", layout: fromOtherTab }]);
  });

  it("sends a queued save after a save that never settles times out", async () => {
    const timeout = new AbortController();
    const timeoutSpy = rs.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const store = await import("./use-free-cells");
    store.setActiveSession("stalled-chat");
    rs.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    store.autoPlaceApp("notes");
    store.autoPlaceProjects();
    expect(puts()).toHaveLength(1);
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    timeoutSpy.mockRestore();

    timeout.abort(new DOMException("timed out", "TimeoutError"));
    await settle();
    const sent = puts();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.layout).toEqual(readLayout("stalled-chat"));
  });

  it("does not resend a stored layout older than an edit it failed to store", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("quota-chat");
    rs.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    store.autoPlaceApp("notes");
    await settle();

    // Storage is full, so the next edit reaches only the server.
    const setItem = Storage.prototype.setItem;
    const full = rs.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === "rome:free-layout:quota-chat")
        throw new DOMException("full", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    store.autoPlaceProjects();
    await settle();
    full.mockRestore();
    const saved = puts().at(-1)!.layout;
    expect(saved).toHaveLength(2);

    rs.mocked(fetch).mockClear();
    serve(saved);
    await store.loadLayoutForSession("quota-chat");
    expect(puts()).toEqual([]);
    expect(readLayout("quota-chat")).toEqual(saved);
  });

  it("saves several tiles' links in one request", async () => {
    const store = await import("./use-free-cells");
    store.setActiveSession("flush-chat");
    store.autoPlaceApp("notes");
    store.autoPlaceApp("calendar");
    await settle();
    const [notes, calendar] = readLayout("flush-chat") as Array<{ id: string }>;
    rs.mocked(fetch).mockClear();

    store.updatePlacementLinks([
      { placementId: notes!.id, route: "detail", params: { id: "n1" } },
      { placementId: calendar!.id, route: "week", params: undefined },
    ]);

    expect(puts()).toEqual([
      {
        url: "/api/chat/sessions/flush-chat/layout",
        layout: [
          expect.objectContaining({ targetId: "notes", route: "detail", params: { id: "n1" } }),
          expect.objectContaining({ targetId: "calendar", route: "week" }),
        ],
      },
    ]);
  });

  it.each([
    ["missing", null],
    ["unreadable", "{not json"],
  ])("loads the server copy when the unsynced layout is %s", async (_case, raw) => {
    const store = await import("./use-free-cells");
    store.setActiveSession("stray-chat");
    localStorage.setItem("rome:free-layout-unsynced:stray-chat", "1");
    if (raw === null) localStorage.removeItem("rome:free-layout:stray-chat");
    else localStorage.setItem("rome:free-layout:stray-chat", raw);
    const server = [{ id: "d", type: "desktop", order: 1 }];
    serve(server);
    await store.loadLayoutForSession("stray-chat");

    expect(puts()).toEqual([]);
    expect(readLayout("stray-chat")).toEqual(server);
    expect(localStorage.getItem("rome:free-layout-unsynced:stray-chat")).toBeNull();
  });

  it("resends an unsynced layout after a reload", async () => {
    const before = await import("./use-free-cells");
    before.setActiveSession("reload-chat");
    rs.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    before.autoPlaceApp("notes");
    await settle();
    const local = readLayout("reload-chat");

    rs.resetModules();
    const store = await import("./use-free-cells");
    store.setActiveSession("reload-chat");
    rs.mocked(fetch).mockClear();
    serve([]);
    await store.loadLayoutForSession("reload-chat");

    expect(readLayout("reload-chat")).toEqual(local);
    expect(puts()).toEqual([{ url: "/api/chat/sessions/reload-chat/layout", layout: local }]);
  });
});
