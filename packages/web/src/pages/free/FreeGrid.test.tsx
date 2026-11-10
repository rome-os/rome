// @rstest-environment jsdom
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { SlotContent, SlotOutlet, SlotProvider } from "@/components/slot";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };
import { FreeGrid } from "./FreeGrid";
import { selectTool, setActiveSession } from "./use-free-cells";

let viewportWidth = 1200;

const mounted = rs.hoisted(() => rs.fn());
const catalog = rs.hoisted(() => ({
  apps: [] as { id: string; displayName: string }[] | null,
}));
rs.mock("@/hooks/use-apps", () => ({ useApps: () => ({ apps: catalog.apps }) }));
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
// Like the real Chat, it fills the phone header's status wherever the header offers one.
rs.mock("@/components/chat/Chat", () => ({
  Chat: (props: { onSessionLayout?: (id: string, layout: unknown[] | null) => void }) => {
    chatHost.onSessionLayout = props.onSessionLayout;
    return (
      <SlotContent name="conciergePhoneStatus">
        <span data-testid="phone-status" />
      </SlotContent>
    );
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
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={queryClient}>
          <SlotProvider>
            <SlotOutlet name="mobileHeader" className="header" />
            <Routes>
              <Route path="/chat/*" element={<FreeGrid />} />
              <Route path="/message" element={grid} />
            </Routes>
          </SlotProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }
  const header = (container: HTMLElement) => container.querySelector<HTMLElement>(".header")!;

  const phoneStatus = (container: HTMLElement) =>
    header(container).querySelector<HTMLElement>("[data-testid='phone-status']");

  it("gives a Concierge chat's status the middle of the header, centred on the whole bar", async () => {
    concierge.chatId = "concierge";
    const { container } = renderAt("/chat/concierge");
    await waitFor(() => expect(phoneStatus(container)).not.toBeNull());
    const middle = phoneStatus(container)!.parentElement!;
    expect(middle.className).toContain("absolute");
    expect(middle.className).toContain("inset-x-0");
    expect(middle.className).toContain("mx-auto");
    // No title row of its own: the chat's status carries the name.
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

  it("names the agent's app beside a titled chat, but not in a Concierge chat's header", async () => {
    concierge.chatId = "concierge";
    const pinned = (appLabel: string, agentName: string) => ({
      appId: appLabel.toLowerCase(),
      appLabel,
      agentName,
      iconUrl: null,
    });
    identity.current = {
      sessionName: "Concierge",
      pinnedAgentMention: pinned("Rome", "core:concierge"),
    };
    const first = renderAt("/chat/concierge");
    await waitFor(() => expect(phoneStatus(first.container)).not.toBeNull());
    expect(header(first.container).textContent).not.toContain("Rome");
    first.unmount();

    identity.current = {
      sessionName: "Plan the launch",
      pinnedAgentMention: pinned("Workflow Studio", "workflow-planner"),
    };
    const second = renderAt("/chat/some-other-chat");
    await waitFor(() => expect(header(second.container).textContent).toContain("Workflow Studio"));
  });

  it("opens the main chat at /message with the Concierge's header", async () => {
    concierge.chatId = "concierge";
    identity.current = { sessionName: "Concierge" };
    const { container } = renderAt(
      "/message",
      { agentName: "Milo" },
      <FreeGrid sessionId="concierge" />,
    );
    await waitFor(() => expect(phoneStatus(container)).not.toBeNull());
    await waitFor(() => expect(document.title).toContain("Milo"));
  });

  it("leads a Concierge chat's menu with a plain Tasks item, and offers no Delete for the main chat", async () => {
    concierge.chatId = "concierge";
    identity.current = { sessionName: "Concierge" };
    const user = userEvent.setup();
    const main = renderAt("/message", {}, <FreeGrid sessionId="concierge" />);
    await user.click(
      await within(header(main.container)).findByRole("button", { name: "More actions" }),
    );
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Tasks",
      "Share chat",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Tasks" }));
    // Beside a wide pane the list opens as the pane's Tasks tab.
    expect(await screen.findByRole("tab", { name: /Tasks/ })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    main.unmount();

    identity.current = { sessionName: "Plan the launch" };
    const other = renderAt("/chat/some-other-chat");
    await user.click(
      await within(header(other.container)).findByRole("button", { name: "More actions" }),
    );
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Tasks" })).toBeNull();
  });

  it("leaves every other chat's header without a status", async () => {
    concierge.chatId = "concierge";
    const { container } = renderAt("/chat/some-other-chat");
    await waitFor(() => expect(header(container).querySelector("button")).not.toBeNull());
    expect(phoneStatus(container)).toBeNull();
  });

  it("leaves the header without a status until the main chat is loaded", async () => {
    const { container } = renderAt("/chat/concierge");
    await waitFor(() => expect(header(container).querySelector("button")).not.toBeNull());
    expect(phoneStatus(container)).toBeNull();
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
