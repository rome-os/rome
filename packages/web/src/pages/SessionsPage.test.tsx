// @rstest-environment jsdom
import type { ComponentProps } from "react";
import type { ChatRow } from "@/components/chat/chat-view";
import type { TraceDrawerTarget } from "@/components/agent-trace/TraceDrawer";
import * as traceDrawerModule from "@/components/agent-trace/TraceDrawer" with {
  rstest: "importActual",
};
import i18n from "@/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as chatApiModule from "@/lib/chat-api" with { rstest: "importActual" };
import * as sessionEventsModule from "@/lib/session-events" with { rstest: "importActual" };
import {
  getRomeSession,
  getSession,
  getSessionMetrics,
  listRomeSessionMessages,
  listRomeSessions,
  listSessionTurns,
  openTurnStream,
  postSessionTurn,
} from "@/lib/chat-api";
import SessionsPage from "./SessionsPage";

const realTraceDrawer = rs.hoisted(() => ({ enabled: false }));
rs.mock("@/components/agent-trace/TraceDrawer", () => ({
  TraceDrawer: (props: ComponentProps<typeof traceDrawerModule.TraceDrawer>) =>
    realTraceDrawer.enabled ? <traceDrawerModule.TraceDrawer {...props} /> : null,
  traceDrawerContentInsetClass: () => "",
}));

rs.mock("@/components/chat/entries", () => ({
  renderFlatEntries: () => null,
  renderSingleEntry: () => null,
}));

rs.mock("@/components/chat/ChatComposer", () => ({
  ChatComposer: ({ onSend, disabled }: { onSend: (s: unknown) => void; disabled?: boolean }) => (
    <button
      type="button"
      data-testid="side-chat-composer"
      disabled={disabled}
      onClick={() =>
        onSend({
          text: "And the failure case?",
          uploads: [],
          reasoningEffort: "medium",
          projectPath: "default",
        })
      }
    >
      send
    </button>
  ),
}));

rs.mock("@/components/chat/MessageList", () => ({
  MessageList: ({
    live,
    rows,
    onOpenStoredTrace,
  }: {
    live: { isStreaming: boolean; text: string };
    rows: ChatRow[];
    onOpenStoredTrace: (target: TraceDrawerTarget) => void;
  }) => (
    <div
      data-testid="session-messages"
      data-streaming={String(live.isStreaming)}
      data-trace-rows={rows
        .filter((row) => row.kind === "trace")
        .map((row) => row.key)
        .join(",")}
    >
      {live.text}
      {realTraceDrawer.enabled
        ? rows.map((row) =>
            row.kind === "trace" && row.message.traceSummary ? (
              <button
                key={row.key}
                type="button"
                onClick={() =>
                  onOpenStoredTrace({
                    kind: "stored",
                    messageId: row.message.id,
                    sessionId: row.message.sessionId,
                    turnId: row.message.turnId ?? null,
                    summary: row.message.traceSummary!,
                  })
                }
              >
                Open stored steps
              </button>
            ) : null,
          )
        : null}
    </div>
  ),
}));

rs.mock("@/lib/chat-api", () => {
  return {
    ...chatApiModule,
    getRomeSession: rs.fn(),
    getSession: rs.fn(),
    getSessionMetrics: rs.fn(),
    listRomeSessionMessages: rs.fn(),
    listRomeSessions: rs.fn(),
    listSessionTurns: rs.fn(),
    openTurnStream: rs.fn(),
    postSessionTurn: rs.fn(),
  };
});

const emitSessionsChanged = rs.hoisted(() => rs.fn());
rs.mock("@/lib/session-events", () => ({
  ...sessionEventsModule,
  emitSessionsChanged,
}));

const FORK_SESSION = {
  id: "feedback-fork-session",
  name: "feedback: original chat",
  displayTitle: "Feedback",
  personaId: null,
  largeModelSelection: null,
  projectName: "default",
  projectPath: "default",
  agentName: null,
  type: "fork",
  sourceChannel: "webchat",
  sourceThreadId: "original-chat",
  sourceThreadName: "Original chat",
  sourceThreadType: "private",
  triggerKind: "fork",
  triggerName: "feedback",
  triggerActionName: null,
  triggerExecutionId: null,
  rootActionExecutionId: null,
  parentActionExecutionId: null,
  parentSessionId: "original-chat",
  parentTurnId: "rated-turn",
  createdAt: "2026-07-12T00:00:00.000Z",
  activityAt: "2026-07-12T00:00:00.000Z",
  messageCount: 1,
  owner: { type: "core", id: "core", label: "Rome", iconUrl: null },
  stats: {
    runCount: 1,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.01,
      costedRunCount: 1,
    },
    outcomes: { completed: 1, interrupted: 0, error: 0, unknown: 0 },
  },
  lineage: {
    parent: {
      id: "original-chat",
      displayTitle: "Original chat",
      type: "webchat",
      agentName: null,
      parentTurnId: null,
      activityAt: "2026-07-12T00:00:00.000Z",
    },
    children: [],
  },
} as const;

function ChatHomeProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <output data-testid="chat-home">
      {location.pathname}
      {location.search} {navigationType}
    </output>
  );
}

function OpenMissingTileSession() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/full/apps/sessions/missing")}>
      Open missing session
    </button>
  );
}

function renderDetail(initialEntry = "/sessions/feedback-fork-session", container?: HTMLElement) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter initialEntries={[initialEntry]}>
        {container ? <OpenMissingTileSession /> : null}
        <Routes>
          <Route path="/sessions/*" element={<SessionsPage />} />
          <Route path="/full/apps/sessions/*" element={<SessionsPage />} />
          <Route path="/chat" element={<ChatHomeProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
    { container },
  );
}

function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Approvals the Activity page's pending banner and Events tab read. */
let approvals: Record<string, unknown>[] = [];

function setRouterHistoryIndex(idx: number) {
  window.history.replaceState({ ...window.history.state, idx }, "");
}

function renderIndex(initialEntry = "/sessions") {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/sessions/*" element={<SessionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The shell-less mount: /full/apps/sessions/* routes outside RomeShellLayout. */
function renderFullMode(initialEntry: string) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/full/apps/sessions/*" element={<SessionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setRouterHistoryIndex(0);
  approvals = [];
  const realFetch = globalThis.fetch;
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/approvals") return Response.json(approvals);
    if (url.startsWith("/api/action-executions") || url.startsWith("/api/webhook-invocations"))
      return Response.json([]);
    return realFetch(input, init);
  });
  rs.mocked(getRomeSession).mockResolvedValue(FORK_SESSION);
  rs.mocked(listRomeSessions).mockResolvedValue({
    sessions: [],
    total: 0,
    offset: 0,
    limit: 5,
    nextOffset: null,
    facets: { types: [], sourceChannels: [] },
  });
  rs.mocked(listRomeSessionMessages).mockResolvedValue([]);
  rs.mocked(listSessionTurns).mockResolvedValue([
    {
      turnId: "feedback-fork-turn",
      streamId: "feedback-fork-turn",
      startedAt: "2026-07-12T00:00:00.000Z",
      status: "running",
    },
  ]);
  rs.mocked(getSession).mockResolvedValue(null);
  rs.mocked(postSessionTurn).mockResolvedValue({
    ok: true,
    data: { turnId: "follow-up-turn", sessionId: "feedback-fork-session", startedAt: "" },
  });
});

afterEach(() => {
  cleanup();
  realTraceDrawer.enabled = false;
  rs.restoreAllMocks();
  rs.clearAllMocks();
});

describe("Sessions viewer archived traces", () => {
  it("shows the archived note instead of an error and Retry for a stale trace button", async () => {
    await i18n.changeLanguage("en");
    realTraceDrawer.enabled = true;
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    rs.mocked(listRomeSessionMessages).mockResolvedValue([
      {
        id: "old-trace",
        sessionId: FORK_SESSION.id,
        turnId: "old-turn",
        role: "trace",
        content: "[]",
        createdAt: "2026-09-24T12:00:00Z",
        traceSummary: { distinctApps: [], totalSteps: 1, invocationCounts: {} },
      },
    ]);
    const fetchTrace = rs
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ trace: null, traceArchived: true })));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Open stored steps" }));
    expect(await screen.findByText("Steps from this turn are archived.")).toBeTruthy();
    expect(fetchTrace).toHaveBeenCalledWith(
      "/api/sessions/messages/old-trace/content?includeSubagentUsage=true",
      { credentials: "include" },
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("SessionsPage missing sessions", () => {
  it.each([
    "/sessions/missing",
    "/full/apps/sessions/missing",
  ])("replaces %s with the main chat page", async (path) => {
    rs.mocked(getRomeSession).mockResolvedValue(null);
    renderDetail(path);

    expect((await screen.findByTestId("chat-home")).textContent).toBe("/chat REPLACE");
    expect(screen.queryByText("Session not found")).toBeNull();
  });

  it("returns home when the session disappears before its messages load", async () => {
    rs.mocked(listRomeSessionMessages).mockResolvedValue(null);
    renderDetail("/sessions/feedback-fork-session?hideSidebar=1");

    expect((await screen.findByTestId("chat-home")).textContent).toBe(
      "/chat?hideSidebar=1 REPLACE",
    );
  });

  it.each([
    ["/full/apps/sessions/missing", false],
    ["/full/apps/sessions/feedback-fork-session", true],
  ])("keeps a missing workspace tile inside its frame from %s", async (entry, navigatesToMissing) => {
    const frame = document.createElement("iframe");
    frame.src = "/full/apps/sessions/missing";
    document.body.appendChild(frame);
    frame.contentDocument!.write("<!doctype html><html><body></body></html>");
    const parentWindow = frame.contentWindow!.parent;
    const postMessage = rs.spyOn(parentWindow, "postMessage").mockImplementation(() => {});
    rs.stubGlobal("window", frame.contentWindow!);
    rs.mocked(getRomeSession).mockImplementation(async (id) =>
      id === FORK_SESSION.id ? FORK_SESSION : null,
    );
    rs.mocked(listSessionTurns).mockResolvedValue([]);

    try {
      const view = renderDetail(entry, frame.contentDocument!.body);
      if (navigatesToMissing) {
        expect(await view.findByText("Feedback")).toBeTruthy();
        fireEvent.click(view.getByRole("button", { name: "Open missing session" }));
      }

      expect(await view.findByText("Session not found")).toBeTruthy();
      // An existing-to-missing move must not keep showing the previous session.
      expect(view.queryByText("Feedback")).toBeNull();
      expect(view.queryByTestId("chat-home")).toBeNull();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      cleanup();
      rs.unstubAllGlobals();
      frame.remove();
    }
  });

  it("keeps temporary server errors on the session page", async () => {
    rs.mocked(getRomeSession).mockRejectedValue(new Error("Service unavailable"));
    renderDetail();

    expect(await screen.findByText("Service unavailable")).toBeTruthy();
    expect(screen.queryByTestId("chat-home")).toBeNull();
  });
});

describe("SessionsPage landmarks", () => {
  // The shell owns the one `main` on /sessions/*. /full/apps/sessions/* mounts
  // outside it, so there the page owns it — on every view, or a reader crossing
  // overview -> all -> detail passes through a page with no landmark.
  it("gives each full-mode view one main with the safe-area frame", async () => {
    rs.mocked(getSessionMetrics).mockResolvedValue({
      scope: { from: "2026-07-08T00:00:00.000Z", to: "2026-07-15T00:00:00.000Z", timeZone: "UTC" },
      totals: {
        sessionCount: 0,
        runCount: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: null,
          costedRunCount: 0,
        },
        outcomes: { completed: 0, interrupted: 0, error: 0, unknown: 0 },
      },
      projections: [],
    });

    for (const entry of ["/full/apps/sessions", "/full/apps/sessions/all"]) {
      const view = renderFullMode(entry);
      await waitFor(() => {
        const mains = view.container.querySelectorAll("main");
        expect(mains.length, `${entry} should carry exactly one main`).toBe(1);
        expect(mains[0].hasAttribute("data-safe-area-bounded")).toBe(true);
      });
      cleanup();
    }
  });

  it("leaves the landmark to the shell on the in-shell mount", async () => {
    const view = renderIndex("/sessions/all");
    await waitFor(() => {
      expect(view.container.querySelectorAll("main").length).toBe(0);
    });
  });
});

describe("SessionsPage live fork details", () => {
  it("returns through router history when available", async () => {
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    setRouterHistoryIndex(1);

    render(
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter
          initialEntries={["/sessions/all", "/sessions/feedback-fork-session"]}
          initialIndex={1}
        >
          <Routes>
            <Route path="/sessions/*" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Back to sessions" }));

    expect(
      (await screen.findByRole("radio", { name: "Sessions" })).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("falls back to the sessions page when router history is empty", async () => {
    rs.mocked(listSessionTurns).mockResolvedValue([]);

    render(
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter initialEntries={["/sessions/feedback-fork-session"]}>
          <Routes>
            <Route path="/sessions" element={<div>Sessions index</div>} />
            <Route path="/sessions/*" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Back to sessions" }));

    expect(await screen.findByText("Sessions index")).toBeTruthy();
  });

  it("attaches to and renders an active fork turn", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    rs.mocked(openTurnStream).mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });
      return new Response(body);
    });

    renderDetail();

    await waitFor(() => {
      expect(openTurnStream).toHaveBeenCalledWith("feedback-fork-turn", expect.any(AbortSignal));
    });
    act(() => {
      streamController?.enqueue(
        new TextEncoder().encode(
          'event: assistant_text\ndata: {"text":"Learning from feedback"}\n\n',
        ),
      );
    });

    expect(await screen.findByText("Learning from feedback")).toBeTruthy();
    expect(screen.getByTestId("session-messages").dataset.streaming).toBe("true");

    act(() => {
      streamController?.enqueue(
        new TextEncoder().encode('event: done\ndata: {"success":true}\n\n'),
      );
      streamController?.close();
    });
    await waitFor(() => expect(listRomeSessionMessages).toHaveBeenCalledTimes(2));
  });

  it("hides a backend turn's saved trace behind its live row once the stream names the turn", async () => {
    // A defer wake-up streams under a synthetic `backend:` turnId but saves
    // its trace under the agent's own turn id.
    rs.mocked(listRomeSessionMessages).mockResolvedValue([
      {
        id: "trace-real",
        sessionId: FORK_SESSION.id,
        turnId: "turn-real",
        role: "trace",
        content: "[]",
        createdAt: "2026-07-12T00:00:00.000Z",
        traceSummary: { distinctApps: [], totalSteps: 1, invocationCounts: {} },
      },
    ]);
    rs.mocked(listSessionTurns).mockResolvedValue([
      { turnId: "backend:wake", streamId: "stream-wake", startedAt: "", status: "running" },
    ]);
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    rs.mocked(openTurnStream).mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });
      return new Response(body);
    });

    renderDetail();

    await waitFor(() =>
      expect(openTurnStream).toHaveBeenCalledWith("backend:wake", expect.any(AbortSignal)),
    );
    await waitFor(() =>
      expect(screen.getByTestId("session-messages").dataset.streaming).toBe("true"),
    );
    act(() => {
      streamController?.enqueue(
        new TextEncoder().encode('event: turn_id\ndata: {"turnId":"turn-real"}\n\n'),
      );
    });

    await waitFor(() => expect(screen.getByTestId("session-messages").dataset.traceRows).toBe(""));
  });

  it("hides a backend turn's saved trace from the first render when the listing names the turn", async () => {
    // The listing already reports `agentTurnId`, so the stream need not send
    // a `turn_id` event before the live row carries the saved trace.
    rs.mocked(listRomeSessionMessages).mockResolvedValue([
      {
        id: "trace-real",
        sessionId: FORK_SESSION.id,
        turnId: "turn-real",
        role: "trace",
        content: "[]",
        createdAt: "2026-07-12T00:00:00.000Z",
        traceSummary: { distinctApps: [], totalSteps: 1, invocationCounts: {} },
      },
    ]);
    rs.mocked(listSessionTurns).mockResolvedValue([
      {
        turnId: "backend:wake",
        agentTurnId: "turn-real",
        streamId: "stream-wake",
        startedAt: "",
        status: "running",
      },
    ]);
    rs.mocked(openTurnStream).mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({ start() {} });
      return new Response(body);
    });

    renderDetail();

    await waitFor(() =>
      expect(openTurnStream).toHaveBeenCalledWith("backend:wake", expect.any(AbortSignal)),
    );
    await waitFor(() =>
      expect(screen.getByTestId("session-messages").dataset.streaming).toBe("true"),
    );
    await waitFor(() => expect(listRomeSessionMessages).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByTestId("session-messages").dataset.traceRows).toBe("");
  });

  it("refreshes messages when a turn finishes during initial attachment", async () => {
    rs.mocked(listSessionTurns).mockResolvedValue([]);

    renderDetail();

    await waitFor(() => expect(listRomeSessionMessages).toHaveBeenCalledTimes(2));
    expect(openTurnStream).not.toHaveBeenCalled();
  });

  it("keeps raw identifiers in a collapsed Technical details section", async () => {
    rs.mocked(listSessionTurns).mockResolvedValue([]);

    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(screen.queryByText("Average duration")).toBeNull();
    const summary = screen.getByText("Technical details");
    const details = summary.closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
    fireEvent.click(summary);
    expect(details?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("feedback-fork-session")).toBeTruthy();
    expect(screen.getAllByText("original-chat").length).toBeGreaterThan(0);
  });

  it("renders a branch read-only: no composer, no sidebar signal", async () => {
    // The Sessions explorer carries no input surface — a branch continues in
    // its chat card, and legacy fork rows are read-only trajectories.
    rs.mocked(listSessionTurns).mockResolvedValue([]);

    renderDetail();

    await screen.findByTestId("session-messages");
    expect(screen.queryByTestId("side-chat-composer")).toBeNull();
    expect(emitSessionsChanged).not.toHaveBeenCalled();
  });
});

describe("SessionsPage explorer", () => {
  it("shows usage overview and switches to the human-readable inventory", async () => {
    rs.mocked(getSessionMetrics).mockResolvedValue({
      scope: { from: "2026-07-08T00:00:00.000Z", to: "2026-07-15T00:00:00.000Z", timeZone: "UTC" },
      totals: {
        sessionCount: 1,
        runCount: 2,
        usage: {
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 300,
          cacheWriteTokens: 0,
          totalTokens: 1_500,
          costUsd: 0.02,
          costedRunCount: 2,
        },
        outcomes: { completed: 2, interrupted: 0, error: 0, unknown: 0 },
      },
      projections: [
        {
          id: "trend",
          groupBy: "model",
          interval: "day",
          rankBy: "tokens",
          groups: [
            {
              key: "model:openai:gpt-5.6",
              label: "gpt-5.6",
              description: "openai",
              iconUrl: null,
              kind: "named",
              dimension: {
                dimension: "model",
                state: "known",
                provider: "openai",
                name: "gpt-5.6",
                label: "gpt-5.6",
              },
              sessionCount: 1,
              runCount: 2,
              usage: {
                inputTokens: 1_000,
                outputTokens: 200,
                cacheReadTokens: 300,
                cacheWriteTokens: 0,
                totalTokens: 1_500,
                costUsd: 0.02,
                costedRunCount: 2,
              },
              outcomes: { completed: 2, interrupted: 0, error: 0, unknown: 0 },
              lastActivityAt: "2026-07-15T00:00:00.000Z",
            },
          ],
          buckets: [],
        },
        {
          id: "breakdown",
          groupBy: "app",
          interval: "none",
          rankBy: "runs",
          buckets: [],
          groups: [
            {
              key: "app:code-review",
              label: "Code Review",
              description: "Agent owner",
              iconUrl: null,
              kind: "named",
              dimension: {
                dimension: "app",
                state: "installed",
                appId: "code-review",
                label: "Code Review",
                iconUrl: null,
              },
              sessionCount: 1,
              runCount: 2,
              usage: {
                inputTokens: 1_000,
                outputTokens: 200,
                cacheReadTokens: 300,
                cacheWriteTokens: 0,
                totalTokens: 1_500,
                costUsd: 0.02,
                costedRunCount: 2,
              },
              outcomes: { completed: 2, interrupted: 0, error: 0, unknown: 0 },
              lastActivityAt: "2026-07-15T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    rs.mocked(listRomeSessions).mockResolvedValue({
      sessions: [
        {
          ...FORK_SESSION,
          id: "review-session",
          name: "generated-name",
          displayTitle: "Review pull request 42",
          type: "action",
          owner: { type: "app", id: "code-review", label: "Code Review", iconUrl: null },
        },
      ],
      total: 1,
      offset: 0,
      limit: 50,
      nextOffset: null,
      facets: {
        types: [{ value: "action", count: 1 }],
        sourceChannels: [{ value: null, count: 1 }],
      },
    });

    renderIndex();
    expect((await screen.findAllByText("1,500")).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Recent sessions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Review pull request 42" })).toBeTruthy();
    expect(listRomeSessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, offset: 0, range: "7d", sort: "activity" }),
    );
    expect(screen.getAllByText("Code Review").length).toBeGreaterThan(0);
    expect(document.querySelector('svg[aria-label="ChatGPT"]')).toBeTruthy();
    expect(document.querySelector('svg[viewBox="0 0 51 48"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="avatar"]')?.className).toContain("rounded-8");
    expect(screen.queryByText("openai")).toBeNull();
    expect(screen.queryByText("Error rate")).toBeNull();
    expect(screen.queryByText("Average duration")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Sessions" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    const search = screen.getByPlaceholderText("Search title, App, Agent, context, or ID");
    fireEvent.change(search, { target: { value: "pull request" } });
    await waitFor(() =>
      expect(listRomeSessions).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50, query: "pull request" }),
      ),
    );
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    fireEvent.click(screen.getAllByText("Review pull request 42")[0]);
    setRouterHistoryIndex(1);
    fireEvent.click(await screen.findByRole("button", { name: "Back to sessions" }));
    expect(
      (await screen.findByPlaceholderText("Search title, App, Agent, context, or ID")).getAttribute(
        "value",
      ),
    ).toBe("pull request");

    cleanup();
    renderIndex("/sessions/all?range=all&groupBy=model&model=openai%3A%3Agpt-5.6");
    expect((await screen.findAllByText("Review pull request 42")).length).toBeGreaterThan(0);
    expect(screen.queryByText("review-session")).toBeNull();
    expect(listRomeSessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, range: "7d", model: undefined }),
    );

    rs.mocked(listSessionTurns).mockResolvedValue([]);
    fireEvent.click(screen.getAllByText("Review pull request 42")[0]);
    expect(await screen.findByRole("button", { name: "Back to sessions" })).toBeTruthy();
  });

  it("filters from the popover, shows what is set as a chip, and sorts from a column header", async () => {
    rs.mocked(listRomeSessions).mockResolvedValue({
      sessions: [
        {
          ...FORK_SESSION,
          id: "review-session",
          displayTitle: "Review pull request 42",
          type: "action",
        },
      ],
      total: 1,
      offset: 0,
      limit: 50,
      nextOffset: null,
      facets: {
        types: [{ value: "action", count: 1 }],
        sourceChannels: [{ value: null, count: 1 }],
      },
    });

    renderIndex("/sessions/all");
    expect((await screen.findAllByText("Review pull request 42")).length).toBeGreaterThan(0);

    // Type and Source live behind one control, so neither is on the row until
    // the popover opens.
    expect(screen.queryByRole("combobox", { name: "Type" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const typeField = await screen.findByRole("combobox", { name: "Type" });
    fireEvent.keyDown(typeField, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /Automation/ }));
    await waitFor(() =>
      expect(listRomeSessions).toHaveBeenCalledWith(expect.objectContaining({ type: "action" })),
    );

    // What is set shows as a removable chip under the toolbar.
    const chip = await screen.findByRole("button", { name: "Clear Type: Automation" });
    fireEvent.click(chip);
    await waitFor(() =>
      expect(listRomeSessions).toHaveBeenCalledWith(expect.objectContaining({ type: undefined })),
    );
    expect(screen.queryByRole("button", { name: "Clear Type: Automation" })).toBeNull();

    // The table header carries the order: first click takes the field at its
    // useful end, a second reverses it.
    const runs = screen.getByRole("button", { name: "Runs" });
    fireEvent.click(runs);
    await waitFor(() =>
      expect(listRomeSessions).toHaveBeenCalledWith(
        expect.objectContaining({ sort: "runs", sortDirection: "desc" }),
      ),
    );
    expect(runs.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(runs);
    await waitFor(() =>
      expect(listRomeSessions).toHaveBeenCalledWith(
        expect.objectContaining({ sort: "runs", sortDirection: "asc" }),
      ),
    );
    expect(runs.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
  });
});

describe("Activity page tabs", () => {
  function PathProbe() {
    const location = useLocation();
    return (
      <output data-testid="path">
        {location.pathname}
        {location.search}
      </output>
    );
  }

  function renderWithProbe(initialEntry: string) {
    return render(
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/sessions/*" element={<SessionsPage />} />
          </Routes>
          <PathProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("switches to Events, which holds the event log", async () => {
    await i18n.changeLanguage("en");
    renderWithProbe("/sessions/all");
    const events = await screen.findByRole("radio", { name: "Events" });
    expect(screen.getByRole("radio", { name: "Overview" })).toBeTruthy();
    fireEvent.click(events);
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/sessions/events"));
    expect(await screen.findByRole("radiogroup", { name: "Activity status" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Events" }).getAttribute("aria-checked")).toBe("true");
  });

  it("says a pending approval waits on the other tabs, and Review opens it on Events", async () => {
    await i18n.changeLanguage("en");
    approvals = [
      {
        id: "a1",
        type: "action_execution",
        status: "pending",
        requestedBy: "main",
        description: "Approval needing a decision",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        resolvedBy: null,
        payload: null,
      },
    ];
    renderWithProbe("/sessions/all");
    const review = await screen.findByRole("button", { name: /1 pending approval/ });
    fireEvent.click(review);
    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/sessions/events?status=pending"),
    );
    const filters = await screen.findByRole("radiogroup", { name: "Activity status" });
    expect(filters.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe(
      "Pending",
    );
  });

  it("shows no pending banner while nothing waits", async () => {
    await i18n.changeLanguage("en");
    renderWithProbe("/sessions/all");
    await screen.findByRole("radio", { name: "Events" });
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/approvals", expect.anything()),
    );
    expect(screen.queryByRole("button", { name: /pending approval/ })).toBeNull();
  });

  it("gives the full-mode Events tab one main with the safe-area frame", async () => {
    await i18n.changeLanguage("en");
    const view = render(
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter initialEntries={["/full/apps/sessions/events"]}>
          <Routes>
            <Route path="/full/apps/sessions/*" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole("radiogroup", { name: "Activity status" });
    const mains = view.container.querySelectorAll("main");
    expect(mains.length).toBe(1);
    expect(mains[0].hasAttribute("data-safe-area-bounded")).toBe(true);
  });
});
