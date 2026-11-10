// @rstest-environment jsdom
import { useEffect } from "react";
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { SlotOutlet, SlotProvider } from "@/components/slot";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { LiveEventsClient } from "@/lib/live-events";
import { RomeShellLayout } from "@/shell/RomeShellLayout";
import {
  acceptLatestSocket,
  FakeWebSocket,
  fakeSocketLiveEventsClient,
} from "@/test/fake-websocket";
import { FreeGrid } from "./FreeGrid";
import { selectTool, setActiveSession } from "./use-free-cells";

let viewportWidth = 1200;

const mounted = rs.hoisted(() => rs.fn());
const catalog = rs.hoisted(() => ({
  apps: [] as { id: string; displayName: string }[] | null,
}));
rs.mock("@/hooks/use-apps", () => ({ useApps: () => ({ apps: catalog.apps }) }));
rs.mock("@/shell/ChatSearchHost", () => ({ ChatSearchHost: () => null }));
rs.mock("@/shell/AppGrid", () => ({ AppGrid: () => null }));
rs.mock("@/shell/ProfileMenu", () => ({ ProfileMenu: () => null }));
rs.mock("@/shell/DesktopTitlebar", () => ({ DesktopTitlebar: () => null }));
rs.mock("@/components/upgrade-countdown-banner", () => ({ UpgradeCountdownBanner: () => null }));
// Concierge's chat id comes from its own query, which these tests do not serve.
const concierge = rs.hoisted(() => ({ chatId: null as string | null }));
rs.mock("@/hooks/use-concierge", () => ({
  ...conciergeModule,
  useConciergeChatId: () => concierge.chatId,
}));
const identity = rs.hoisted(() => ({
  current: { sessionName: null } as {
    sessionName: string | null;
    pinnedAgentMention?: { appId: string; appLabel: string; agentName: string; iconUrl: null };
  },
}));
rs.mock("@/components/chat/use-session-identity", () => ({
  useSessionIdentity: () => identity.current,
}));
// The host's `onSessionLayout`, which the real Chat calls when a session's first
// messages page arrives; tests call it to play that arrival.
const chatHost = rs.hoisted(() => ({
  onSessionLayout: undefined as ((id: string, layout: unknown[] | null) => void) | undefined,
}));
rs.mock("@/components/chat/Chat", () => ({
  Chat: (props: { onSessionLayout?: (id: string, layout: unknown[] | null) => void }) => {
    chatHost.onSessionLayout = props.onSessionLayout;
    return null;
  },
}));
rs.mock("./AppWidget", () => ({
  AppWidget: ({ placementId }: { placementId: string }) => {
    useEffect(() => {
      mounted(placementId);
    }, [placementId]);
    return <iframe title="Seeded app" />;
  },
}));

function NavigationProbe({ withProject }: { withProject: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location-state">{JSON.stringify(location.state)}</output>
      <button
        type="button"
        onClick={() =>
          navigate("/chat", {
            state: {
              widgets: [{ type: "app", appId: "notes" }],
              ...(withProject ? { projectPath: "project" } : {}),
              futureKey: { keep: true },
            },
          })
        }
      >
        Open notes
      </button>
    </>
  );
}

function Grid({ withProject = true }: { withProject?: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/chat"]}>
      <QueryClientProvider client={queryClient}>
        <SlotProvider>
          <FreeGrid />
          <NavigationProbe withProject={withProject} />
        </SlotProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function renderGrid(withProject = true) {
  return render(<Grid withProject={withProject} />);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  viewportWidth = 1200;
  mounted.mockClear();
  catalog.apps = [];
  rs.stubGlobal(
    "fetch",
    rs.fn((input: RequestInfo | URL) =>
      Promise.resolve(Response.json(String(input) === "/api/settings" ? {} : [])),
    ),
  );
  rs.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.getAttribute("data-testid") === "tool-workspace") {
          this.callback(
            [{ target, contentRect: { width: viewportWidth } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
      }
      unobserve() {}
      disconnect() {}
    },
  );
  chatHost.onSessionLayout = undefined;
  localStorage.clear();
  setActiveSession("reset");
  setActiveSession(null);
  rs.mocked(fetch).mockClear();
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
  localStorage.clear();
  concierge.chatId = null;
  identity.current = { sessionName: null };
});

describe("FreeGrid navigation seeds", () => {
  it("uses a generic tab until the catalog arrives, without remounting the app", async () => {
    catalog.apps = null;
    const view = renderGrid();
    fireEvent.click(screen.getByRole("button", { name: "Open notes" }));
    const iframe = screen.getByTitle("Seeded app");
    expect(screen.getByRole("tab", { name: "Apps" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close Apps" })).toBeTruthy();
    catalog.apps = [{ id: "notes", displayName: "Personal Notes" }];
    view.rerender(<Grid />);
    expect(screen.getByRole("tab", { name: "Personal Notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close Personal Notes" })).toBeTruthy();
    expect(screen.getByTitle("Seeded app")).toBe(iframe);
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("places widgets once and consumes widget and project prefill without changing selection", async () => {
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: "Open notes" }));
    const iframe = screen.getByTitle("Seeded app");
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("location-state").textContent!)).toEqual({
        futureKey: { keep: true },
      }),
    );
    expect(screen.getByTitle("Seeded app")).toBe(iframe);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tab", { name: "notes" }).getAttribute("aria-selected")).toBe("true");
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/layout"), expect.anything());
  });

  it.each([
    true,
    false,
  ])("reopens and selects the same widget navigation (project: %s)", async (withProject) => {
    renderGrid(withProject);
    fireEvent.click(screen.getByRole("button", { name: "Open notes" }));
    const first = screen.getByTitle("Seeded app");
    expect(mounted).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close notes" }));
    expect(screen.queryByTitle("Seeded app")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open notes" }));
    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(2));
    expect(screen.getByTitle("Seeded app")).not.toBe(first);
    expect(mounted.mock.calls[1][0]).not.toBe(mounted.mock.calls[0][0]);
    expect(screen.getByRole("tab", { name: "notes" }).getAttribute("aria-selected")).toBe("true");
    expect(JSON.parse(screen.getByTestId("location-state").textContent!)).toEqual({
      futureKey: { keep: true },
    });
  });
});

describe("FreeGrid mobile header", () => {
  function renderAt(
    path: string,
    settings: Record<string, unknown> = {},
    // `/message` names no chat, so its page hands the grid the main chat's id.
    grid = <FreeGrid />,
    shell = false,
    live?: LiveEventsClient,
  ) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rs.stubGlobal(
      "fetch",
      rs.fn((input: RequestInfo | URL) => {
        const url = String(input);
        return Promise.resolve(
          Response.json(
            url === "/api/settings"
              ? settings
              : url.startsWith("/api/concierge/tasks")
                ? {
                    tasks: [
                      {
                        id: "t1",
                        title: "Blocked",
                        state: "needs_user",
                        summary: null,
                        waitingOn: "an answer",
                        dueAt: null,
                        rank: null,
                        chat: null,
                        createdAt: 1,
                        updatedAt: 1,
                        completedAt: null,
                        archivedAt: null,
                        notSynced: false,
                        conciergeChat: { id: "concierge", name: "Concierge", main: true },
                      },
                    ],
                  }
                : [],
          ),
        );
      }),
    );
    return render(
      <LiveEventsClientContext.Provider value={live ?? new LiveEventsClient()}>
        <MemoryRouter initialEntries={[path]}>
          <QueryClientProvider client={queryClient}>
            <SlotProvider>
              {shell ? null : <SlotOutlet name="mobileHeader" className="header" />}
              <Routes>
                <Route element={shell ? <RomeShellLayout /> : <Outlet />}>
                  <Route path="/chat/*" element={<FreeGrid />} />
                  <Route path="/message" element={grid} />
                </Route>
              </Routes>
            </SlotProvider>
          </QueryClientProvider>
        </MemoryRouter>
      </LiveEventsClientContext.Provider>,
    );
  }
  const header = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".header, header[data-mobile-header]")!;

  it("refreshes the main chat header and document title with the chat list closed, including after reconnect", async () => {
    concierge.chatId = "concierge";
    const settings = { agentName: "Flint", guardianLanguage: "en" };
    const client = fakeSocketLiveEventsClient();
    rs.stubGlobal(
      "matchMedia",
      rs.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: rs.fn(),
        removeEventListener: rs.fn(),
      })),
    );
    const { container, unmount } = renderAt(
      "/message",
      settings,
      <FreeGrid sessionId="concierge" />,
      true,
      client,
    );
    try {
      await waitFor(() => expect(header(container).textContent).toContain("Flint"));
      expect(document.title).toContain("Flint");
      expect(container.querySelector("[data-phone-chat-list]")).toBeNull();
      expect(container.querySelector("[data-projects-section]")).toBeNull();
      const socket = acceptLatestSocket();
      settings.agentName = "Pebble";
      act(() =>
        socket.receive({
          type: "event",
          topic: "chat.status",
          event: "agent_name_changed",
          data: { agentName: "Pebble" },
        }),
      );
      await waitFor(() => expect(header(container).textContent).toContain("Pebble"));
      expect(header(container).textContent).not.toContain("Flint");
      expect(document.title).toContain("Pebble");
      expect(rs.mocked(fetch).mock.calls.filter(([url]) => url === "/api/settings")).toHaveLength(
        2,
      );
      const count = FakeWebSocket.instances.length;
      act(() => socket.close());
      settings.agentName = "Boulder";
      await waitFor(() => expect(FakeWebSocket.instances.length).toBe(count + 1));
      act(() => {
        acceptLatestSocket();
      });
      await waitFor(() => expect(header(container).textContent).toContain("Boulder"));
      expect(document.title).toContain("Boulder");
    } finally {
      unmount();
    }
  });

  const moreButton = (container: HTMLElement) =>
    within(header(container)).findByRole("button", { name: "More actions" });

  it("leaves a Concierge chat's bar without a title, since the chat floats its own header", async () => {
    concierge.chatId = "concierge";
    identity.current = { sessionName: "Concierge" };
    const { container } = renderAt("/chat/concierge", { agentName: "Milo" });
    await moreButton(container);
    expect(header(container).textContent).not.toContain("Milo");
    expect(header(container).textContent).not.toContain("Concierge");
    expect(header(container).querySelector("[data-concierge-tasks-pill]")).toBeNull();
  });

  it("names the tab after the main Concierge chat's chosen name, and any other chat after its own", async () => {
    concierge.chatId = "concierge";
    identity.current = { sessionName: "Concierge" };
    const first = renderAt("/chat/concierge", { agentName: "Milo" });
    await waitFor(() => expect(document.title).toContain("Milo"));
    first.unmount();

    identity.current = { sessionName: "Plan the launch" };
    const second = renderAt("/chat/some-other-chat", { agentName: "Milo" });
    await waitFor(() => expect(header(second.container).textContent).toContain("Plan the launch"));
    expect(header(second.container).textContent).not.toContain("Milo");
  });

  it("names the agent's app beside a titled chat", async () => {
    concierge.chatId = "concierge";
    identity.current = {
      sessionName: "Plan the launch",
      pinnedAgentMention: {
        appId: "workflow-studio",
        appLabel: "Workflow Studio",
        agentName: "workflow-planner",
        iconUrl: null,
      },
    };
    const { container } = renderAt("/chat/some-other-chat");
    await waitFor(() => expect(header(container).textContent).toContain("Workflow Studio"));
  });

  it("offers no Delete for the main chat in the phone header's menu", async () => {
    concierge.chatId = "concierge";
    identity.current = { sessionName: "Concierge" };
    const user = userEvent.setup();
    const main = renderAt("/message", {}, <FreeGrid sessionId="concierge" />);
    await user.click(await moreButton(main.container));
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    await user.keyboard("{Escape}");
    main.unmount();

    identity.current = { sessionName: "Plan the launch" };
    const other = renderAt("/chat/some-other-chat");
    await user.click(await moreButton(other.container));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });
});

describe("FreeGrid workspace re-entry", () => {
  const layout = [{ id: "notes", type: "app", targetId: "notes", order: 0 }];

  function Navigation() {
    const navigate = useNavigate();
    return (
      <>
        <button type="button" onClick={() => navigate("/apps")}>
          Visit apps
        </button>
        <button type="button" onClick={() => navigate("/projects")}>
          Visit projects
        </button>
        <button type="button" onClick={() => navigate("/chat/a")}>
          Return to chat
        </button>
        <button
          type="button"
          onClick={() =>
            navigate("/chat/a", { state: { widgets: [{ type: "app", appId: "calendar" }] } })
          }
        >
          Return with widgets
        </button>
      </>
    );
  }

  async function reenter(page = "apps", width = 390, handoff = false) {
    viewportWidth = width;
    rs.stubGlobal("innerWidth", width);
    localStorage.setItem("rome:free-layout:a", JSON.stringify(layout));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={["/chat/a"]}>
        <QueryClientProvider client={queryClient}>
          <SlotProvider>
            <SlotOutlet name="mobileHeader" />
            <Navigation />
            <Routes>
              <Route path="/chat/*" element={<FreeGrid />} />
              <Route path="/apps" element={<p>Apps page</p>} />
              <Route path="/projects" element={<p>Projects page</p>} />
            </Routes>
          </SlotProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await act(async () => {});
    // The first messages page carries the saved layout.
    act(() => chatHost.onSessionLayout?.("a", layout));
    const toggle = screen.queryByRole("button", { name: "Show apps" });
    if (toggle) fireEvent.click(toggle);
    expect(screen.getByTestId("workspace-chat").style.display).toBe(width < 721 ? "none" : "");
    const saved = localStorage.getItem("rome:tool-view:a");
    act(() => setActiveSession("a"));
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("focus"));
    expect(screen.getAllByRole("button", { name: "Hide apps" })[0]).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Visit ${page}` }));
    expect(screen.queryByTestId("workspace-chat")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: handoff ? "Return with widgets" : "Return to chat" }),
    );
    // The remounted chat reports its first page again, as the re-entry load did.
    const respond = () => chatHost.onSessionLayout?.("a", layout);
    return { saved, respond };
  }

  it.each([
    "apps",
    "projects",
  ])("returns to chat after visiting /%s without persisting collapse", async (page) => {
    const { saved, respond } = await reenter(page);
    expect(screen.getByTestId("workspace-chat").style.display).toBe("");
    expect(localStorage.getItem("rome:tool-view:a")).toBe(saved);
    await act(async () => {
      respond();
    });
    expect(screen.getByTestId("workspace-chat").style.display).toBe("");
    expect(localStorage.getItem("rome:tool-view:a")).toBe(saved);
  });

  it.each([
    "toggle",
    "link",
  ])("keeps an explicit %s open during the re-entry load", async (action) => {
    const { respond } = await reenter();
    expect(screen.getByTestId("workspace-chat").style.display).toBe("");
    if (action === "toggle") fireEvent.click(screen.getByRole("button", { name: "Show apps" }));
    else act(() => selectTool("notes"));
    await act(async () => {
      respond();
    });
    expect(screen.getByTestId("workspace-chat").style.display).toBe("none");
    expect(screen.getByRole("tab", { name: "notes" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps a narrow widget handoff chat-first after re-entry", async () => {
    const { respond } = await reenter("apps", 390, true);
    expect(screen.getByTestId("workspace-chat").style.display).toBe("");
    await act(async () => {
      respond();
    });
    await waitFor(() => expect(localStorage.getItem("rome:free-layout:a")).toContain("calendar"));
    expect(screen.getByTestId("workspace-chat").style.display).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Show apps" }));
    expect(screen.getByRole("tab", { name: "calendar" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it.each([721, 1280])("keeps the saved pane open on same-chat remount at %s px", async (width) => {
    const { saved, respond } = await reenter("apps", width);
    expect(screen.getAllByRole("button", { name: "Hide apps" })[0]).toBeTruthy();
    await act(async () => {
      respond();
    });
    expect(screen.getAllByRole("button", { name: "Hide apps" })[0]).toBeTruthy();
    expect(localStorage.getItem("rome:tool-view:a")).toBe(saved);
  });
});

describe("FreeGrid layout from the first messages page", () => {
  const cached = [{ id: "notes", type: "app", targetId: "notes", order: 0 }];
  const fromServer = [{ id: "files", type: "projects", order: 0 }];

  function renderSession(id: string, state?: unknown) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <MemoryRouter initialEntries={[{ pathname: `/chat/${id}`, state }]}>
        <QueryClientProvider client={queryClient}>
          <SlotProvider>
            <Routes>
              <Route path="/chat/*" element={<FreeGrid />} />
            </Routes>
          </SlotProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it("shows the cached layout on the first render and never fetches /layout", () => {
    localStorage.setItem("rome:free-layout:cached-chat", JSON.stringify(cached));
    renderSession("cached-chat");
    expect(screen.getByRole("tab", { name: "notes" })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/layout"), expect.anything());
  });

  it("applies the layout the first page carries", () => {
    renderSession("server-chat");
    expect(screen.queryByRole("tab")).toBeNull();
    act(() => chatHost.onSessionLayout?.("server-chat", fromServer));
    expect(screen.getByRole("tab", { name: "Projects" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("rome:free-layout:server-chat")!)).toEqual(fromServer);
  });

  it("places a widget handoff on top of the layout once the first page applied it", () => {
    renderSession("handoff-chat", { widgets: [{ type: "app", appId: "calendar" }] });
    expect(screen.queryByRole("tab", { name: "calendar" })).toBeNull();
    act(() => chatHost.onSessionLayout?.("handoff-chat", fromServer));
    expect(screen.getByRole("tab", { name: "Projects" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "calendar" })).toBeTruthy();
  });
});
