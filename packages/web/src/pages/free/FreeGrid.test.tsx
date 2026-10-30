// @rstest-environment jsdom
import { useEffect, type ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { SlotOutlet, SlotProvider } from "@/components/slot";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };
import { FreeGrid } from "./FreeGrid";
import { setActiveSession } from "./use-free-cells";

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
rs.mock("@/components/chat/use-session-identity", () => ({
  useSessionIdentity: () => ({ sessionName: null }),
}));
const chatProps = rs.hoisted(() => ({ sessionId: undefined as string | null | undefined }));
rs.mock("@/components/chat/Chat", () => ({
  Chat: (props: { sessionId?: string | null }) => {
    chatProps.sessionId = props.sessionId;
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

function Grid({
  withProject = true,
  grid = <FreeGrid />,
}: {
  withProject?: boolean;
  grid?: ReactElement;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/chat"]}>
      <QueryClientProvider client={queryClient}>
        <SlotProvider>
          {grid}
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
            [{ target, contentRect: { width: 1200 } } as ResizeObserverEntry],
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

describe("FreeGrid kept alive for one chat", () => {
  it("shows the chat it is pinned to, whatever the address", async () => {
    render(<Grid grid={<FreeGrid sessionId="concierge" />} />);
    await waitFor(() => expect(chatProps.sessionId).toBe("concierge"));
  });

  it("draws no tool layout while it is not the grid on screen, and gets it back", async () => {
    const view = render(<Grid grid={<FreeGrid sessionId="concierge" />} />);
    fireEvent.click(screen.getByRole("button", { name: "Open notes" }));
    expect(await screen.findByTitle("Seeded app")).toBeTruthy();

    view.rerender(<Grid grid={<FreeGrid sessionId="concierge" active={false} />} />);
    expect(screen.queryByTitle("Seeded app")).toBeNull();

    view.rerender(<Grid grid={<FreeGrid sessionId="concierge" />} />);
    expect(screen.getByTitle("Seeded app")).toBeTruthy();
  });
});
