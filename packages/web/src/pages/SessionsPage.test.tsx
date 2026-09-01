// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import SessionsPage, { sessionsViewportClass } from "./SessionsPage";
import { SESSION_OVERVIEW_GROUPS } from "./SessionsOverview";

vi.mock("@/components/agent-trace/TraceDrawer", () => ({
  TraceDrawer: () => null,
  traceDrawerContentInsetClass: () => "",
}));

vi.mock("@/components/chat/blocks", () => ({
  renderFlatBlocks: () => null,
  renderSingleBlock: () => null,
}));

vi.mock("@/components/chat/ChatComposer", () => ({
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

vi.mock("@/components/chat/MessageList", () => ({
  MessageList: ({ live }: { live: { isStreaming: boolean; text: string } }) => (
    <div data-testid="session-messages" data-streaming={String(live.isStreaming)}>
      {live.text}
    </div>
  ),
}));

vi.mock("@/lib/chat-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat-api")>();
  return {
    ...actual,
    getRomeSession: vi.fn(),
    getSession: vi.fn(),
    getSessionMetrics: vi.fn(),
    listRomeSessionMessages: vi.fn(),
    listRomeSessions: vi.fn(),
    listSessionTurns: vi.fn(),
    openTurnStream: vi.fn(),
    postSessionTurn: vi.fn(),
  };
});

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

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/sessions/feedback-fork-session"]}>
      <Routes>
        <Route path="/sessions/*" element={<SessionsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setRouterHistoryIndex(idx: number) {
  window.history.replaceState({ ...window.history.state, idx }, "");
}

function renderIndex(initialEntry = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/sessions/*" element={<SessionsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setRouterHistoryIndex(0);
  vi.mocked(getRomeSession).mockResolvedValue(FORK_SESSION);
  vi.mocked(listRomeSessions).mockResolvedValue({
    sessions: [],
    total: 0,
    offset: 0,
    limit: 5,
    nextOffset: null,
    facets: { types: [], sourceChannels: [] },
  });
  vi.mocked(listRomeSessionMessages).mockResolvedValue([]);
  vi.mocked(listSessionTurns).mockResolvedValue([
    {
      turnId: "feedback-fork-turn",
      streamId: "feedback-fork-turn",
      startedAt: "2026-07-12T00:00:00.000Z",
      status: "running",
    },
  ]);
  vi.mocked(getSession).mockResolvedValue(null);
  vi.mocked(postSessionTurn).mockResolvedValue({
    ok: true,
    data: { turnId: "follow-up-turn", sessionId: "feedback-fork-session", startedAt: "" },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("sessionsViewportClass", () => {
  it("keeps the standard mobile shell surface edge-to-edge", () => {
    expect(sessionsViewportClass(false)).toContain("h-[var(--rome-mobile-content-height)]");
    expect(sessionsViewportClass(false)).not.toContain("pb-safe");
  });

  it("protects the top edge in full mode without shrinking its bottom surface", () => {
    expect(sessionsViewportClass(true)).toContain("pt-safe");
    expect(sessionsViewportClass(true)).not.toContain("pb-safe");
  });
});

describe("SessionsPage live fork details", () => {
  it("returns through router history when available", async () => {
    vi.mocked(listSessionTurns).mockResolvedValue([]);
    setRouterHistoryIndex(1);

    render(
      <MemoryRouter
        initialEntries={["/sessions/all", "/sessions/feedback-fork-session"]}
        initialIndex={1}
      >
        <Routes>
          <Route path="/sessions/*" element={<SessionsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Back to sessions" }));

    expect(
      (await screen.findByRole("radio", { name: "Sessions" })).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("falls back to the sessions page when router history is empty", async () => {
    vi.mocked(listSessionTurns).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/sessions/feedback-fork-session"]}>
        <Routes>
          <Route path="/sessions" element={<div>Sessions index</div>} />
          <Route path="/sessions/*" element={<SessionsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Back to sessions" }));

    expect(await screen.findByText("Sessions index")).toBeTruthy();
  });

  it("attaches to and renders an active fork turn", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.mocked(openTurnStream).mockImplementation(async () => {
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

  it("refreshes messages when a turn finishes during initial attachment", async () => {
    vi.mocked(listSessionTurns).mockResolvedValue([]);

    renderDetail();

    await waitFor(() => expect(listRomeSessionMessages).toHaveBeenCalledTimes(2));
    expect(openTurnStream).not.toHaveBeenCalled();
  });

  it("keeps raw identifiers in a collapsed Technical details section", async () => {
    vi.mocked(listSessionTurns).mockResolvedValue([]);

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

  // The default openTurnStream mock resolves to undefined, so the live-turn
  // effect bails before its completion branch. Anything that needs the turn to
  // *finish* has to hand it a real stream.
  function mockFinishableTurnStream() {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.mocked(openTurnStream).mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      return new Response(body);
    });
    return () =>
      act(() => {
        controller?.enqueue(new TextEncoder().encode('event: done\ndata: {"success":true}\n\n'));
        controller?.close();
      });
  }

  it("shows no composer on a fork the backend will not continue", async () => {
    vi.mocked(listSessionTurns).mockResolvedValue([]);

    renderDetail();

    await screen.findByTestId("session-messages");
    expect(screen.queryByTestId("side-chat-composer")).toBeNull();
  });

  it("re-probes continuability once the first branch answer lands", async () => {
    // The view opens while the fork is still running, so the first probe
    // legitimately 404s. The composer must appear when the turn ends.
    vi.mocked(getSession)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "feedback-fork-session" } as never);
    const finish = mockFinishableTurnStream();

    renderDetail();
    await screen.findByTestId("session-messages");
    expect(screen.queryByTestId("side-chat-composer")).toBeNull();

    await waitFor(() => expect(openTurnStream).toHaveBeenCalled());
    finish();

    expect(await screen.findByTestId("side-chat-composer")).toBeTruthy();
  });

  it("sends a follow-up, refreshes the transcript, and re-attaches the live turn", async () => {
    vi.mocked(getSession).mockResolvedValue({ id: "feedback-fork-session" } as never);
    vi.mocked(listSessionTurns).mockResolvedValue([]);

    renderDetail();

    const composer = await screen.findByTestId("side-chat-composer");
    const reloads = vi.mocked(listRomeSessionMessages).mock.calls.length;
    const turnLookups = vi.mocked(listSessionTurns).mock.calls.length;
    await act(async () => {
      fireEvent.click(composer);
    });

    await waitFor(() => {
      expect(postSessionTurn).toHaveBeenCalledWith("feedback-fork-session", expect.any(FormData));
    });
    const form = vi.mocked(postSessionTurn).mock.calls[0][1];
    expect(form.get("text")).toBe("And the failure case?");
    // The guardian's own message shows before the reply does.
    await waitFor(() => {
      expect(vi.mocked(listRomeSessionMessages).mock.calls.length).toBeGreaterThan(reloads);
    });
    await waitFor(() => {
      expect(vi.mocked(listSessionTurns).mock.calls.length).toBeGreaterThan(turnLookups);
    });
  });

  it("attaches to an accepted follow-up that is still queued", async () => {
    // The turns endpoint reports a turn as `queued` until it becomes the
    // session's current turn. Skipping those loses the reply: the turn runs
    // server-side and nothing ever opens its stream.
    vi.mocked(getSession).mockResolvedValue({ id: "feedback-fork-session" } as never);
    vi.mocked(listSessionTurns).mockResolvedValue([
      {
        turnId: "queued-follow-up",
        streamId: "queued-follow-up",
        startedAt: "2026-09-01T00:00:00.000Z",
        status: "queued",
      },
    ]);
    mockFinishableTurnStream();

    renderDetail();

    await waitFor(() => {
      expect(openTurnStream).toHaveBeenCalledWith("queued-follow-up", expect.any(AbortSignal));
    });
  });

  it("keeps the composer through a transient probe failure", async () => {
    // `getSession` returns null only on 404. Anything else — a 500, a network
    // blip — throws, and treating that as "not continuable" would drop the
    // composer off a live branch until the next probe.
    vi.mocked(listSessionTurns).mockResolvedValue([]);
    vi.mocked(getSession)
      .mockResolvedValueOnce({ id: "feedback-fork-session" } as never)
      .mockRejectedValue(new Error("boom"));

    renderDetail();

    const composer = await screen.findByTestId("side-chat-composer");
    await act(async () => {
      fireEvent.click(composer);
    });

    expect(screen.getByTestId("side-chat-composer")).toBeTruthy();
  });

  it("refuses a second send while the first is still in flight", async () => {
    // This view follows only the first running turn, so a queued second turn
    // would run server-side and never render.
    vi.mocked(getSession).mockResolvedValue({ id: "feedback-fork-session" } as never);
    vi.mocked(listSessionTurns).mockResolvedValue([]);
    let release: (() => void) | undefined;
    vi.mocked(postSessionTurn).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              data: { turnId: "follow-up-turn", sessionId: "feedback-fork-session", startedAt: "" },
            });
        }),
    );

    renderDetail();

    const composer = await screen.findByTestId("side-chat-composer");
    fireEvent.click(composer);
    await waitFor(() => expect((composer as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(composer);

    expect(postSessionTurn).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.();
    });
  });
});

describe("SessionsPage explorer", () => {
  it("only exposes identity-oriented overview groups and ignores legacy query state", async () => {
    expect(SESSION_OVERVIEW_GROUPS).toEqual(["app", "agent", "model", "project"]);
    vi.mocked(getSessionMetrics).mockResolvedValue({
      scope: {
        from: "2026-07-08T00:00:00.000Z",
        to: "2026-07-15T00:00:00.000Z",
        timeZone: "UTC",
      },
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

    renderIndex("/sessions?groupBy=source&range=all");

    await waitFor(() =>
      expect(getSessionMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ groupBy: "app", range: "7d" }),
      ),
    );
    expect(screen.getByRole("combobox", { name: "Group by" }).textContent).toContain("Apps");
  });

  it("shows usage overview and switches to the human-readable inventory", async () => {
    vi.mocked(getSessionMetrics).mockResolvedValue({
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
    vi.mocked(listRomeSessions).mockResolvedValue({
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
    vi.mocked(listSessionTurns).mockResolvedValue([]);
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

    vi.mocked(listSessionTurns).mockResolvedValue([]);
    fireEvent.click(screen.getAllByText("Review pull request 42")[0]);
    expect(await screen.findByRole("button", { name: "Back to sessions" })).toBeTruthy();
  });
});
