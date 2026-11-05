// @rstest-environment jsdom
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { SlotOutlet, SlotProvider } from "@/components/slot";
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
rs.mock("@/components/chat/Chat", () => ({ Chat: () => null }));
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
  function renderAt(path: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rs.stubGlobal(
      "fetch",
      rs.fn((input: RequestInfo | URL) => {
        const url = String(input);
        return Promise.resolve(
          Response.json(
            url === "/api/settings"
              ? {}
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
            </Routes>
          </SlotProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }
  const header = (container: HTMLElement) => container.querySelector<HTMLElement>(".header")!;

  it("puts the tasks pill beside the Concierge's name", async () => {
    concierge.chatId = "concierge";
    const { container } = renderAt("/chat/concierge");
    await waitFor(() =>
      expect(header(container).querySelector("[data-concierge-tasks-pill]")).not.toBeNull(),
    );
    const pill = header(container).querySelector<HTMLElement>("[data-concierge-tasks-pill]")!;
    await waitFor(() => expect(pill.getAttribute("data-state")).toBe("needsYou"));
    expect(pill.getAttribute("aria-label")).toBe("Tasks, 1 needs you");
  });

  it("names the agent's app beside a titled chat, but not beside the Concierge's name", async () => {
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
    await waitFor(() =>
      expect(header(first.container).querySelector("[data-concierge-tasks-pill]")).not.toBeNull(),
    );
    expect(header(first.container).textContent).not.toContain("Rome");
    first.unmount();

    identity.current = {
      sessionName: "Plan the launch",
      pinnedAgentMention: pinned("Workflow Studio", "workflow-planner"),
    };
    const second = renderAt("/chat/some-other-chat");
    await waitFor(() => expect(header(second.container).textContent).toContain("Workflow Studio"));
  });

  it("leaves every other chat's header without it", async () => {
    concierge.chatId = "concierge";
    const { container } = renderAt("/chat/some-other-chat");
    await waitFor(() => expect(header(container).querySelector("button")).not.toBeNull());
    expect(header(container).querySelector("[data-concierge-tasks-pill]")).toBeNull();
  });

  it("leaves the header without it while Concierge is off", async () => {
    const { container } = renderAt("/chat/concierge");
    await waitFor(() => expect(header(container).querySelector("button")).not.toBeNull());
    expect(header(container).querySelector("[data-concierge-tasks-pill]")).toBeNull();
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
    let loads = 0;
    let respond!: (response: Response) => void;
    rs.mocked(fetch).mockImplementation((input) => {
      if (String(input) === "/api/chat/sessions/a/layout") {
        if (++loads === 2)
          return new Promise<Response>((resolve) => {
            respond = resolve;
          });
        return Promise.resolve(Response.json({ layout }));
      }
      return Promise.resolve(Response.json(String(input) === "/api/settings" ? {} : []));
    });
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
    expect(loads).toBe(2);
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
      respond(Response.json({ layout }));
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
      respond(Response.json({ layout }));
    });
    expect(screen.getByTestId("workspace-chat").style.display).toBe("none");
    expect(screen.getByRole("tab", { name: "notes" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps a narrow widget handoff chat-first after re-entry", async () => {
    const { respond } = await reenter("apps", 390, true);
    expect(screen.getByTestId("workspace-chat").style.display).toBe("");
    await act(async () => {
      respond(Response.json({ layout }));
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
      respond(Response.json({ layout }));
    });
    expect(screen.getAllByRole("button", { name: "Hide apps" })[0]).toBeTruthy();
    expect(localStorage.getItem("rome:tool-view:a")).toBe(saved);
  });
});
