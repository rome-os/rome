// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as chatApiModule from "@/lib/chat-api" with { rstest: "importActual" };
import { Chat } from "./Chat";
import { autoPlaceApp } from "@/pages/free/use-free-cells";
import {
  deleteSession,
  interruptTurn,
  listSessionMessages,
  listSessionTurns,
  openTurnStream,
  postSessionTurn,
} from "@/lib/chat-api";

const t = (key: string) => key;
const mockUseSessionIdentity = rs.hoisted(() => rs.fn());
const appsPanel = rs.hoisted(() => ({ collapsed: true, setCollapsed: rs.fn() }));
const mockFindActiveSubmission = rs.hoisted(() => rs.fn(() => null));
const mockUseChatTabStatus = rs.hoisted(() => rs.fn());

rs.mock("@/hooks/use-tab-status", () => ({
  useChatTabStatus: mockUseChatTabStatus,
}));

rs.mock("react-i18next", () => ({
  useTranslation: () => ({ t }),
}));

rs.mock("@/components/chat/use-session-identity", () => ({
  useSessionIdentity: mockUseSessionIdentity,
}));

rs.mock("@/pages/free/workspace-context", () => ({
  snapshotWorkspaceForSend: () => null,
  useWorkspaceContextRegistry: () => null,
}));

rs.mock("@/pages/free/workspace-event-bus", () => ({
  useWorkspaceEventBus: () => null,
}));

rs.mock("@/pages/free/use-free-cells", () => ({
  autoPlaceApp: rs.fn(),
  useFreeCells: () => ({
    addWidget: rs.fn(),
    placements: [],
    toolView: { activeId: null, collapsed: appsPanel.collapsed, unreadIds: [] },
    setToolsCollapsed: appsPanel.setCollapsed,
  }),
}));

// Mutable so a test can put the viewport away from the tail; reset in beforeEach.
const stickToBottom = rs.hoisted(() => ({ isAtBottom: true, scrollToBottom: rs.fn() }));

rs.mock("@/hooks/use-stick-to-bottom", () => ({
  // Callback refs, matching the real hook. Chat composes these with its own
  // refs and CALLS them, so a ref object here would throw on mount — and a
  // rs.mock factory is not checked against the module's real shape, so nothing
  // but a test run would catch it.
  useStickToBottom: () => ({
    contentRef: rs.fn(),
    scrollRef: rs.fn(),
    isAtBottom: stickToBottom.isAtBottom,
    scrollToBottom: stickToBottom.scrollToBottom,
  }),
}));

rs.mock("@/hooks/use-smooth-text", () => ({
  useSmoothText: (text: string) => text,
}));

rs.mock("@/components/agent-trace/TraceDrawer", () => ({
  TraceDrawer: () => null,
  traceDrawerContentInsetClass: () => "",
}));

rs.mock("@/components/chat/AgentAvatar", () => ({
  AgentAvatar: () => null,
}));

rs.mock("@/components/chat/ShareBar", () => ({
  ShareBar: () => null,
}));

rs.mock("@/pages/free/WidgetPicker", () => ({
  WidgetPicker: () => null,
}));

rs.mock("@/components/chat/MessageList", () => ({
  MessageList: ({ live }: { live: { identity: { name: string } } }) => (
    <div data-testid="message-list">{live.identity.name}</div>
  ),
  findActiveSubmission: mockFindActiveSubmission,
  findLastSubmission: () => null,
  hasPendingApprovalConfirmation: () => false,
}));

rs.mock("@/components/chat/ChatComposer", () => ({
  // Expose the streaming state + Stop wiring so tests can drive stopMessage
  // the way the real composer's Stop button does.
  ChatComposer: (props: {
    isStreaming?: boolean;
    onStop?: () => void;
    onSend?: (snapshot: unknown, controls: unknown) => Promise<void>;
  }) => (
    <div data-testid="chat-composer" data-streaming={props.isStreaming ? "true" : "false"}>
      {props.isStreaming && props.onStop ? (
        <button type="button" data-testid="stop-button" onClick={props.onStop} />
      ) : null}
      {props.onSend ? (
        <button
          type="button"
          data-testid="send-button"
          onClick={() =>
            void props
              .onSend?.(
                { text: "hi", uploads: [], reasoningEffort: "medium", projectPath: "" },
                { onUploadProgress: () => {}, signal: new AbortController().signal },
              )
              .catch(() => {})
          }
        />
      ) : null}
    </div>
  ),
}));

rs.mock("@/components/chat/entries", () => ({
  renderFlatEntries: () => null,
  renderSingleEntry: () => null,
}));

rs.mock("@/lib/chat-api", () => {
  return {
    ...chatApiModule,
    deleteSession: rs.fn(),
    interruptTurn: rs.fn(),
    listSessionMessages: rs.fn().mockResolvedValue([]),
    listSessionTurns: rs.fn().mockResolvedValue([{ turnId: "turn-1", status: "running" }]),
    markSessionRead: rs.fn().mockResolvedValue({
      sessionId: "session-1",
      lastSeenActivityAt: null,
      unread: false,
    }),
    openTurnStream: rs.fn((_turnId: string, signal?: AbortSignal) => {
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return Promise.resolve(new Response(body));
    }),
    postSessionTurn: rs.fn(),
    postSessionTurnJson: rs.fn(),
  };
});

function renderChat(children: ReactNode) {
  return render(<MemoryRouter>{children}</MemoryRouter>);
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  readyState = MockEventSource.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string | URL) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: MessageEvent<string>) => void);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener as (event: MessageEvent<string>) => void);
  }

  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitLifecycle(type: "open" | "error", readyState: number) {
    this.readyState = readyState;
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event as MessageEvent<string>);
  }

  close() {}
}

beforeEach(() => {
  appsPanel.collapsed = true;
  stickToBottom.isAtBottom = true;
  mockUseSessionIdentity.mockReturnValue({
    sessionName: null,
    pinnedAgentMention: null,
    archivedAt: null,
  });
});

afterEach(() => {
  rs.useRealTimers();
  cleanup();
  rs.clearAllMocks();
  rs.unstubAllGlobals();
  MockEventSource.instances = [];
});

describe("Chat read marking", () => {
  it("leaves a chat unread while its tab is hidden, then marks it on return", async () => {
    const { markSessionRead } = await import("@/lib/chat-api");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      renderChat(<Chat sessionId="session-1" />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(markSessionRead).not.toHaveBeenCalled();

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(markSessionRead).toHaveBeenCalledWith("session-1"));
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});

describe("Chat agent identity", () => {
  it("binds generic canvas consumers to the chat canvas", () => {
    const { container } = renderChat(<Chat sessionId="session-1" />);
    const chatRoot = container.querySelector('[class~="bg-chat-canvas"]');

    expect(chatRoot?.classList.contains("[--background:var(--chat-canvas)]")).toBe(true);
  });

  it("shows the expand control only while the apps panel is collapsed", async () => {
    const user = userEvent.setup();
    const { rerender } = renderChat(<Chat sessionId="session-1" />);
    await user.click(screen.getByRole("button", { name: "chat.expandTools" }));
    expect(appsPanel.setCollapsed).toHaveBeenCalledWith(false);
    appsPanel.collapsed = false;
    rerender(
      <MemoryRouter>
        <Chat sessionId="session-1" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: "chat.expandTools" })).toBeNull();
    appsPanel.collapsed = true;
    rerender(
      <MemoryRouter>
        <Chat sessionId="session-1" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "chat.expandTools" })).toBeTruthy();
  });

  it("shows the session model in the chat header", () => {
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "A conversation",
      model: "gpt-5.5",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(<Chat sessionId="session-1" />);
    expect(screen.getByLabelText("navbar.sessionModel").textContent).toBe("gpt-5.5");
  });

  it("shows the effort the session's last turn ran with beside the model", () => {
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "A conversation",
      model: "gpt-5.5",
      reasoningEffort: "max",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(<Chat sessionId="session-1" />);
    // The provider's own effort term, with no mapping to composer labels.
    expect(screen.getByLabelText("navbar.sessionModelWithEffort").textContent).toBe(
      "gpt-5.5 · max",
    );
  });

  it("does not invent a model for a session without a pin", () => {
    renderChat(<Chat sessionId="session-1" />);
    expect(screen.queryByLabelText("navbar.sessionModel")).toBeNull();
  });

  it("uses the guardian-chosen name for the default main agent", () => {
    renderChat(<Chat sessionId="session-1" mainAgentDisplayName="  Atlas  " />);

    expect(screen.getByTestId("message-list").textContent).toBe("Atlas");
  });

  it("keeps a session-pinned app agent ahead of the main agent display name", () => {
    mockUseSessionIdentity.mockReturnValue({
      sessionName: null,
      pinnedAgentMention: {
        appId: "workflow-studio",
        appLabel: "Workflow Studio",
        agentName: "workflow-planner",
        iconUrl: null,
      },
      archivedAt: null,
    });

    renderChat(<Chat sessionId="session-1" mainAgentDisplayName="Atlas" />);

    expect(screen.getByTestId("message-list").textContent).toBe("Workflow Planner");
  });
});

describe("Chat session events", () => {
  it("delivers a validated inserted message to the active session", async () => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const onSessionMessage = rs.fn();
    renderChat(<Chat sessionId="session-1" onSessionMessage={onSessionMessage} />);

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    act(() => {
      MockEventSource.instances[0]?.emit("message_insert", {
        id: "message-1",
        sessionId: "session-1",
        turnId: "turn-2",
        role: "assistant",
        content: "[]",
        createdAt: "2026-07-18T00:00:00.000Z",
      });
    });

    expect(onSessionMessage).toHaveBeenCalledWith({ sessionId: "session-1", turnId: "turn-2" });
  });

  it("refreshes the session list when a generated name arrives", async () => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const onSessionsChanged = rs.fn();
    renderChat(<Chat sessionId="session-1" onSessionsChanged={onSessionsChanged} />);

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    onSessionsChanged.mockClear();
    act(() => {
      MockEventSource.instances[0]?.emit("session_name", {
        sessionId: "session-1",
        name: "Q4 Launch Plan",
      });
    });

    expect(onSessionsChanged).toHaveBeenCalledOnce();
  });

  it("resyncs messages after reconnect and when the session event stream closes", async () => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    renderChat(<Chat sessionId="session-1" />);

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalled());
    rs.mocked(listSessionMessages).mockClear();
    const source = MockEventSource.instances[0]!;

    act(() => {
      source.emitLifecycle("open", MockEventSource.OPEN);
      source.emitLifecycle("error", MockEventSource.CONNECTING);
    });
    expect(listSessionMessages).not.toHaveBeenCalled();

    act(() => source.emitLifecycle("open", MockEventSource.OPEN));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());

    rs.mocked(listSessionMessages).mockClear();
    act(() => source.emitLifecycle("error", MockEventSource.CLOSED));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());
  });
});

describe("Chat turn stream lifecycle", () => {
  it("deletes a chat only after the app confirmation dialog is confirmed", async () => {
    const user = userEvent.setup();
    renderChat(<Chat sessionId="session-1" />);

    await user.click(screen.getByRole("button", { name: "navbar.more" }));
    await user.click(screen.getByRole("menuitem", { name: "navbar.delete" }));

    const dialog = screen.getByRole("dialog", { name: "navbar.delete" });
    expect(deleteSession).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "navbar.delete" }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("session-1"));
  });

  it("aborts an attached turn stream when the chat unmounts", async () => {
    const { unmount } = renderChat(<Chat sessionId="session-1" />);

    await waitFor(() => expect(openTurnStream).toHaveBeenCalledWith("turn-1", expect.any(Object)));
    const signal = rs.mocked(openTurnStream).mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);

    unmount();

    expect(signal?.aborted).toBe(true);
  });

  // Regression: a dropped turn SSE (mobile background, network swap) is not a
  // turn outcome. The chat must stay live and reopen the same turn's stream
  // instead of flashing Send until the next reattach poll.
  describe("when the turn stream drops mid-turn", () => {
    const encoder = new TextEncoder();
    const doneStream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: done\ndata: {"success":true}\n\n'));
            controller.close();
          },
        }),
      );
    const droppingStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const droppingStream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            droppingStreams.push(controller);
          },
        }),
      );

    const defaultOpenTurnStream = rs.mocked(openTurnStream).getMockImplementation();
    beforeEach(() => {
      droppingStreams.length = 0;
      rs.mocked(listSessionTurns)
        .mockResolvedValueOnce([{ turnId: "turn-1", status: "running" }])
        .mockResolvedValue([]);
    });
    afterEach(() => {
      rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
      rs.mocked(openTurnStream).mockReset().mockImplementation(defaultOpenTurnStream!);
    });

    it.each([
      ["replays done", () => Promise.resolve(doneStream())],
      ["404s", () => Promise.resolve(new Response(null, { status: 404 }))],
    ])("stays live, then settles once the resumed stream %s", async (_label, resume) => {
      rs.mocked(openTurnStream)
        .mockImplementationOnce(() => Promise.resolve(droppingStream()))
        .mockImplementationOnce(resume);
      renderChat(<Chat sessionId="session-1" />);
      const composer = () => screen.getByTestId("chat-composer").getAttribute("data-streaming");

      await waitFor(() => expect(composer()).toBe("true"));
      const reloadsBeforeDrop = rs.mocked(listSessionMessages).mock.calls.length;
      await act(async () => {
        droppingStreams[0]!.error(new TypeError("network connection was lost"));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      // Still live: the drop alone neither ends the turn nor reloads.
      expect(composer()).toBe("true");
      expect(rs.mocked(listSessionMessages).mock.calls.length).toBe(reloadsBeforeDrop);

      await waitFor(() => expect(composer()).toBe("false"), { timeout: 3_000 });
      expect(rs.mocked(openTurnStream).mock.calls.map(([turnId]) => turnId)).toEqual([
        "turn-1",
        "turn-1",
      ]);
      expect(rs.mocked(listSessionMessages).mock.calls.length).toBeGreaterThan(reloadsBeforeDrop);
    });
  });

  it("does not start a second follower when a send lands during a reattach lookup", async () => {
    let resolveLookup!: (turns: { turnId: string; status: "running" }[]) => void;
    rs.mocked(listSessionTurns)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveLookup = resolve)))
      .mockResolvedValue([]);
    rs.mocked(postSessionTurn).mockResolvedValue({ ok: true, data: { turnId: "turn-1" } });
    try {
      renderChat(<Chat sessionId="session-1" />);
      await waitFor(() => expect(listSessionTurns).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByTestId("send-button"));
      await waitFor(() => expect(openTurnStream).toHaveBeenCalledTimes(1));
      await act(async () => {
        resolveLookup([{ turnId: "turn-1", status: "running" }]);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(openTurnStream).toHaveBeenCalledTimes(1);
      expect(rs.mocked(openTurnStream).mock.calls[0]?.[1]?.aborted).toBe(false);
    } finally {
      rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    }
  });

  it("follows a turn sent right after Stop releases a dead stream", async () => {
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    rs.mocked(interruptTurn).mockResolvedValue(new Response(null, { status: 404 }));
    rs.mocked(postSessionTurn)
      .mockResolvedValueOnce({ ok: true, data: { turnId: "turn-1" } })
      .mockResolvedValueOnce({ ok: true, data: { turnId: "turn-2" } });
    try {
      renderChat(<Chat sessionId="session-1" />);
      const composer = () => screen.getByTestId("chat-composer").getAttribute("data-streaming");

      fireEvent.click(screen.getByTestId("send-button"));
      await waitFor(() => expect(composer()).toBe("true"));
      fireEvent.click(screen.getByTestId("stop-button"));
      await waitFor(() => expect(composer()).toBe("false"));

      fireEvent.click(screen.getByTestId("send-button"));
      // Well inside the 1 s resume backoff: the new turn gets its own follower.
      await waitFor(
        () => expect(openTurnStream).toHaveBeenCalledWith("turn-2", expect.any(Object)),
        { timeout: 500 },
      );
      expect(composer()).toBe("true");
    } finally {
      rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    }
  });

  it("keeps a background turn's replayed trace and widgets from retargeting the host", async () => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const encoder = new TextEncoder();
    const dropping: ReadableStreamDefaultController<Uint8Array>[] = [];
    const defaultOpen = rs.mocked(openTurnStream).getMockImplementation();
    rs.mocked(listSessionTurns)
      .mockResolvedValueOnce([{ turnId: "turn-1", status: "running" }])
      .mockResolvedValue([]);
    rs.mocked(openTurnStream)
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ start: (c) => void dropping.push(c) })),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(
                  encoder.encode(
                    'event: segment_upsert\ndata: {"id":"seg-1","kind":"text"}\n\n' +
                      'event: widget_placement\ndata: {"appId":"notes"}\n\n' +
                      'event: done\ndata: {"success":true}\n\n',
                  ),
                );
                c.close();
              },
            }),
          ),
        ),
      );
    const onSessionMessage = rs.fn();
    try {
      renderChat(<Chat sessionId="session-1" onSessionMessage={onSessionMessage} />);
      await waitFor(() => expect(openTurnStream).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));

      // The parent hands the floor to a specialist child.
      act(() => {
        MockEventSource.instances[0]?.emit("message_insert", {
          id: "m-handoff",
          sessionId: "session-1",
          turnId: "turn-1",
          role: "assistant",
          content: JSON.stringify([
            {
              type: "handoff",
              toolUseId: "h1",
              appId: "workflow-studio",
              childSessionId: "child-1",
              payload: { agentLabel: "Planner" },
            },
          ]),
          createdAt: "2026-10-06T00:00:00.000Z",
        });
      });
      await waitFor(() =>
        expect(onSessionMessage).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: "child-1" }),
        ),
      );
      onSessionMessage.mockClear();

      // The parent's stream drops and its resumed replay carries a segment.
      await act(async () => {
        dropping[0]!.error(new TypeError("network connection was lost"));
      });
      await waitFor(() => expect(openTurnStream).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(onSessionMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "session-1", segment: expect.anything() }),
      );
      expect(autoPlaceApp).not.toHaveBeenCalled();
    } finally {
      rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
      rs.mocked(openTurnStream).mockReset().mockImplementation(defaultOpen!);
    }
  });

  // Regression: on mobile, a backgrounded/locked page silently kills the turn
  // SSE — the streaming entry then outlives the turn, and tapping Stop hit a
  // finished turn (interrupt → 404) that used to be swallowed with no effect
  // until the next message send resynced. Stop must release the stale entry
  // and reload the transcript on the tap itself.
  it("releases a stale streaming entry when interrupt reports the turn is gone", async () => {
    renderChat(<Chat sessionId="session-1" />);

    // The reattach poll installs the streaming entry for turn-1; the mocked
    // stream never emits, mirroring a dead connection.
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    const signal = rs.mocked(openTurnStream).mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);

    // The turn is over server-side: interrupt 404s and the turn list is empty
    // (so the reattach poll can't resurrect the entry).
    rs.mocked(interruptTurn).mockResolvedValue(new Response(null, { status: 404 }));
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    const reloadsBeforeStop = rs.mocked(listSessionMessages).mock.calls.length;

    fireEvent.click(screen.getByTestId("stop-button"));

    await waitFor(() => expect(interruptTurn).toHaveBeenCalledWith("turn-1"));
    // The stale entry is force-released: streaming flips off, the dead
    // stream's controller is aborted, and the transcript reloads to show the
    // turn's real terminal state.
    await waitFor(() =>
      expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("false"),
    );
    expect(signal?.aborted).toBe(true);
    await waitFor(() =>
      expect(rs.mocked(listSessionMessages).mock.calls.length).toBeGreaterThan(reloadsBeforeStop),
    );
  });

  it("keeps Stop available while the server still reports the turn running", async () => {
    rs.mocked(interruptTurn).mockResolvedValue(new Response(null, { status: 202 }));
    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    const signal = rs.mocked(openTurnStream).mock.calls[0]?.[1];

    rs.useFakeTimers();
    fireEvent.click(screen.getByTestId("stop-button"));
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_500);
    });
    expect(signal?.aborted).toBe(false);
    expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("true");

    // Retry is real, and a missed done can still be recovered once confirmed.
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    fireEvent.click(screen.getByTestId("stop-button"));
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_500);
    });
    expect(interruptTurn).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(true);
    expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("false");
  });

  it("does not let a delayed force-release abort a fresh stream for the same turn", async () => {
    const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    rs.mocked(openTurnStream).mockImplementation((_turnId: string, signal?: AbortSignal) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamControllers.push(controller);
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return Promise.resolve(new Response(body));
    });
    rs.mocked(interruptTurn).mockResolvedValue(new Response(null, { status: 200 }));
    renderChat(<Chat sessionId="session-1" />);

    await waitFor(() => expect(openTurnStream).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    const originalSignal = rs.mocked(openTurnStream).mock.calls[0]?.[1];
    expect(originalSignal?.aborted).toBe(false);

    rs.useFakeTimers();
    fireEvent.click(screen.getByTestId("stop-button"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(interruptTurn).toHaveBeenCalledWith("turn-1");

    // The original stream dies while the force-release grace period is
    // pending. The reconnect poll attaches a new controller to the same turn.
    await act(async () => {
      streamControllers[0]!.error(new Error("connection lost"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(openTurnStream).toHaveBeenCalledTimes(2);
    const replacementSignal = rs.mocked(openTurnStream).mock.calls[1]?.[1];
    expect(replacementSignal?.aborted).toBe(false);

    // The old Stop timer fires at 2.5s. It must recognize that the controller
    // changed instead of aborting the healthy replacement.
    await act(async () => {
      await rs.advanceTimersByTimeAsync(500);
    });
    expect(replacementSignal?.aborted).toBe(false);
    expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("true");
  });
});

describe("Chat tab status", () => {
  afterEach(() => {
    mockFindActiveSubmission.mockReturnValue(null);
    rs.mocked(listSessionMessages).mockResolvedValue([]);
    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
  });

  it("counts a specialist submission waiting on Approve as needing the guardian", async () => {
    mockFindActiveSubmission.mockReturnValue({ messageId: "sub-1", payload: { plan: "x" } });
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    rs.mocked(listSessionMessages).mockImplementation(async (sessionId: string) =>
      sessionId === "session-1"
        ? [
            {
              id: "m-handoff",
              sessionId: "session-1",
              turnId: "turn-1",
              role: "assistant",
              content: JSON.stringify([
                {
                  type: "handoff",
                  toolUseId: "h1",
                  appId: "workflow-studio",
                  childSessionId: "child-1",
                  payload: { agentLabel: "Planner" },
                },
              ]),
              createdAt: "2026-10-05T00:00:00.000Z",
            },
          ]
        : [],
    );
    renderChat(<Chat sessionId="session-1" />);

    await waitFor(() =>
      expect(mockUseChatTabStatus).toHaveBeenLastCalledWith(false, true, expect.any(Number)),
    );
  });
});

describe("Chat jump to latest", () => {
  it("hides the control while the viewport is already at the tail", () => {
    renderChat(<Chat sessionId="session-1" />);
    expect(screen.getByLabelText("jumpToLatest").className).toContain("invisible");
  });

  it("jumps instantly once the viewport has left the tail", async () => {
    stickToBottom.isAtBottom = false;
    renderChat(<Chat sessionId="session-1" />);
    // Chat's session-switch effect has already logged its own scrollToBottom
    // ("auto") by now, which would satisfy the assertion below on its own —
    // leaving the click free to pass anything. Only the click's call may count.
    stickToBottom.scrollToBottom.mockClear();

    const control = screen.getByLabelText("jumpToLatest");
    expect(control.className).not.toContain("invisible");
    await userEvent.click(control);

    // "auto", not "smooth": a smooth animation's first scroll event lands inside
    // the hook's user-gesture window while still short of the bottom, and is read
    // as the user scrolling away — releasing the pin this click just re-engaged.
    expect(stickToBottom.scrollToBottom).toHaveBeenCalledWith("auto");
  });
});
