// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as chatApiModule from "@/lib/chat-api" with { rstest: "importActual" };
import { Chat } from "./Chat";
import type { ChatComposerProps } from "./ChatComposer";
import {
  deleteSession,
  interruptTurn,
  listSessionMessages,
  listSessionTurns,
  openTurnStream,
  postSessionTurn,
  postSessionTurnJson,
} from "@/lib/chat-api";

const t = (key: string) => key;
const mockUseSessionIdentity = rs.hoisted(() => rs.fn());
const appsPanel = rs.hoisted(() => ({ collapsed: true, setCollapsed: rs.fn() }));

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
  MessageList: ({
    live,
    actions,
    rows,
  }: {
    live: { identity: { name: string }; isStreaming: boolean; text: string };
    rows: { key: string }[];
    actions: {
      onSubmitAppComponent: (
        sessionId: string,
        toolUseId: string,
        output: Record<string, unknown>,
      ) => void;
    };
  }) => (
    <div
      data-testid="message-list"
      data-streaming={String(live.isStreaming)}
      data-live-text={live.text}
      data-row-keys={rows.map((row) => row.key).join(",")}
    >
      {live.identity.name}
      <button
        type="button"
        data-testid="submit-off-floor"
        onClick={() => actions.onSubmitAppComponent("other-session", "tool-1", {})}
      />
      <button
        type="button"
        data-testid="submit-prior-floor"
        onClick={() => actions.onSubmitAppComponent("session-1", "tool-2", {})}
      />
    </div>
  ),
  findActiveSubmission: () => null,
  findLastSubmission: () => null,
  hasPendingApprovalConfirmation: () => false,
}));

rs.mock("@/components/chat/ChatComposer", () => ({
  // Expose the streaming state + Stop wiring so tests can drive stopMessage
  // the way the real composer's Stop button does.
  ChatComposer: (props: ChatComposerProps) => (
    <div
      data-testid="chat-composer"
      data-streaming={props.isStreaming ? "true" : "false"}
      data-error={typeof props.streamError === "string" ? props.streamError : ""}
    >
      <button
        type="button"
        data-testid="send-button"
        onClick={() => {
          void Promise.resolve(
            props.onSend(
              { text: "Hello", uploads: [], reasoningEffort: "medium", projectPath: "" },
              { onUploadProgress: () => {}, signal: new AbortController().signal },
            ),
          ).catch(() => {});
        }}
      />
      {props.isStreaming && props.onStop ? (
        <button type="button" data-testid="stop-button" onClick={props.onStop} />
      ) : null}
      {props.recoveryNotice && (
        <div data-testid="recovery-notice">
          <button
            type="button"
            data-testid="retry-recovery"
            onClick={props.recoveryNotice.onRetry}
          />
          <button
            type="button"
            data-testid="reset-recovery"
            onClick={props.recoveryNotice.onReset}
          />
        </div>
      )}
    </div>
  ),
}));

rs.mock("@/components/chat/blocks", () => ({
  renderFlatBlocks: () => null,
  renderSingleBlock: () => null,
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
    openTurnStream: rs.fn(),
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
  rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
  rs.mocked(openTurnStream).mockImplementation((_turnId: string, signal?: AbortSignal) => {
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
  });
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
  it("reloads the prior answer before replacing its preview with the next running turn", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
            },
          }),
        ),
      ),
    );
    let turnLookups = 0;
    rs.mocked(listSessionTurns).mockImplementation(async () =>
      ++turnLookups === 1
        ? [{ turnId: "turn-1", status: "running" }]
        : [{ turnId: "turn-2", status: "running" }],
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(openTurnStream).toHaveBeenCalledWith("turn-1", expect.any(Object)));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalled());
    rs.mocked(listSessionMessages).mockRejectedValueOnce(new Error("transient reload failure"));
    rs.mocked(listSessionMessages).mockResolvedValue([
      {
        id: "answer-1",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: "Completed answer" }]),
        createdAt: "2026-09-30T14:00:00.000Z",
      },
    ]);

    rs.useFakeTimers();
    await act(async () => {
      controllers[0]!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(2_000);
    });

    expect(openTurnStream).not.toHaveBeenCalledWith("turn-2", expect.any(Object));
    expect(screen.getByTestId("stop-button")).toBeTruthy();
    await act(async () => {
      await rs.advanceTimersByTimeAsync(4_000);
    });
    expect(openTurnStream).toHaveBeenCalledWith("turn-2", expect.any(Object));
    expect(screen.getByTestId("message-list").dataset.rowKeys).toContain("answer-1");
  });

  it("keeps the live preview when terminal message reload fails", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalled());
    await act(async () => {
      streamController!.enqueue(
        new TextEncoder().encode('event: assistant_text\ndata: {"blockIx":0,"text":"Done"}\n\n'),
      );
    });
    rs.mocked(listSessionMessages).mockRejectedValueOnce(new Error("reload failed"));
    rs.mocked(listSessionMessages).mockResolvedValue([
      {
        id: "answer-1",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: "Done" }]),
        createdAt: "2026-09-30T14:00:00.000Z",
      },
    ]);
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    rs.useFakeTimers();
    await act(async () => {
      streamController!.enqueue(
        new TextEncoder().encode('event: done\ndata: {"success":true}\n\n'),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("message-list").dataset.liveText).toBe("Done");
    expect(screen.getByTestId("stop-button")).toBeTruthy();

    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByTestId("message-list").dataset.rowKeys).toContain("answer-1");
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");
  });

  it("releases a cancelled reattachment after the floor moves away", async () => {
    rs.mocked(listSessionTurns).mockImplementation(async (sid) =>
      sid === "session-1" ? [{ turnId: "turn-1", status: "running" }] : [],
    );
    rs.mocked(postSessionTurnJson).mockResolvedValue({ ok: true, data: { turnId: "turn-2" } });
    const { rerender } = renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(openTurnStream).toHaveBeenCalledWith("turn-1", expect.any(Object)));
    const signal = rs.mocked(openTurnStream).mock.calls[0]?.[1];

    rerender(
      <MemoryRouter>
        <Chat sessionId="session-2" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(signal?.aborted).toBe(true));
    fireEvent.click(screen.getByTestId("submit-prior-floor"));

    await waitFor(() => expect(openTurnStream).toHaveBeenCalledWith("turn-2", expect.any(Object)));
  });

  it("releases recovery when the floor changes during a pending turn lookup", async () => {
    let resolveRecoveryLookup: ((turns: { turnId: string; status: string }[]) => void) | null =
      null;
    let sessionOneLookups = 0;
    rs.mocked(listSessionTurns).mockImplementation((sid) => {
      if (sid !== "session-1") return Promise.resolve([]);
      if (++sessionOneLookups === 1) {
        return Promise.resolve([{ turnId: "turn-1", status: "running" }]);
      }
      return new Promise((resolve) => {
        resolveRecoveryLookup = resolve;
      });
    });
    rs.mocked(postSessionTurnJson).mockResolvedValue({ ok: true, data: { turnId: "turn-2" } });
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );

    const { rerender } = renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(sessionOneLookups).toBe(2);
    expect(resolveRecoveryLookup).not.toBeNull();

    rerender(
      <MemoryRouter>
        <Chat sessionId="session-2" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("submit-prior-floor"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(openTurnStream).toHaveBeenCalledWith("turn-2", expect.any(Object));

    await act(async () => {
      resolveRecoveryLookup!([{ turnId: "turn-1", status: "running" }]);
      await Promise.resolve();
    });
  });

  it("recovers a reattached turn after its effect is cancelled by a floor change", async () => {
    rs.mocked(listSessionTurns).mockImplementation(async (sid) =>
      sid === "session-1" ? [{ turnId: "turn-1", status: "running" }] : [],
    );
    const { rerender } = renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    const signal = rs.mocked(openTurnStream).mock.calls[0]?.[1];

    rerender(
      <MemoryRouter>
        <Chat sessionId="session-2" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(signal?.aborted).toBe(true));
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    rerender(
      <MemoryRouter>
        <Chat sessionId="session-1" />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false"),
    );
    expect(
      rs.mocked(listSessionTurns).mock.calls.filter(([sid]) => sid === "session-1"),
    ).toHaveLength(2);
  });

  it("recovers a reattached turn after a failed follow-up restarts the effect", async () => {
    rs.mocked(postSessionTurn).mockRejectedValue(new Error("send failed"));
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    const signal = rs.mocked(openTurnStream).mock.calls[0]?.[1];
    rs.mocked(listSessionTurns).mockResolvedValue([]);

    rs.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByTestId("send-button"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });

    expect(signal?.aborted).toBe(true);
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");
  });

  it("does not retain a dropped foreground stream for a session without the floor", async () => {
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    rs.mocked(postSessionTurnJson)
      .mockResolvedValueOnce({ ok: true, data: { turnId: "other-turn-1" } })
      .mockResolvedValueOnce({ ok: true, data: { turnId: "other-turn-2" } });
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    fireEvent.click(screen.getByTestId("submit-off-floor"));
    await waitFor(() =>
      expect(openTurnStream).toHaveBeenCalledWith("other-turn-1", expect.any(Object)),
    );

    await act(async () => {
      controllers[0]!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("submit-off-floor"));
    await waitFor(() =>
      expect(openTurnStream).toHaveBeenCalledWith("other-turn-2", expect.any(Object)),
    );
  });

  it("does not let an old empty turn lookup settle a newer foreground turn", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
            },
          }),
        ),
      ),
    );
    rs.mocked(postSessionTurn).mockResolvedValue({ ok: true, data: { turnId: "turn-2" } });
    rs.mocked(interruptTurn).mockResolvedValue(new Response(null, { status: 404 }));
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());

    let resolveTurns: (turns: []) => void = () => {};
    rs.mocked(listSessionTurns).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTurns = resolve;
        }),
    );
    rs.useFakeTimers();
    await act(async () => {
      controllers[0]!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(2_000);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-button"));
      await rs.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");
    await act(async () => {
      fireEvent.click(screen.getByTestId("send-button"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(openTurnStream).toHaveBeenCalledWith("turn-2", expect.any(Object));
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("true");

    await act(async () => resolveTurns([]));
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("true");
    expect(screen.getByTestId("stop-button")).toBeTruthy();
  });

  it("does not settle recovery from an empty lookup predating an accepted follow-up", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    rs.mocked(postSessionTurn).mockResolvedValue({ ok: true, data: { turnId: "turn-2" } });
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());

    let resolveTurns: (turns: []) => void = () => {};
    rs.mocked(listSessionTurns).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTurns = resolve;
        }),
    );
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(2_000);
    });
    fireEvent.click(screen.getByTestId("send-button"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(postSessionTurn).toHaveBeenCalled();
    expect(listSessionTurns).toHaveBeenCalledTimes(3);

    await act(async () => resolveTurns([]));
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("true");
    expect(screen.getByTestId("stop-button")).toBeTruthy();
  });

  it("keeps the live preview until the final answer reload succeeds", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalled());
    await act(async () => {
      streamController!.enqueue(
        new TextEncoder().encode(
          'event: assistant_text\ndata: {"blockIx":0,"text":"Final answer"}\n\n',
        ),
      );
    });

    let rejectReload: (reason: Error) => void = () => {};
    rs.mocked(listSessionMessages).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectReload = reject;
        }),
    );
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByTestId("message-list").dataset.liveText).toBe("Final answer");
    expect(screen.getByTestId("stop-button")).toBeTruthy();

    await act(async () => rejectReload(new Error("transient message load failure")));
    expect(screen.getByTestId("message-list").dataset.liveText).toBe("Final answer");
    expect(screen.getByTestId("stop-button")).toBeTruthy();

    rs.mocked(listSessionMessages).mockResolvedValue([
      {
        id: "answer-1",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: "Final answer" }]),
        createdAt: "2026-09-30T14:00:00.000Z",
      },
    ]);
    await act(async () => {
      await rs.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByTestId("message-list").dataset.rowKeys).toContain("answer-1");
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");
  });

  it("replaces optimistic input when a recovered turn settles", async () => {
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    rs.mocked(postSessionTurn).mockResolvedValue({
      ok: true,
      data: { turnId: "turn-1", inputId: "optimistic-1" },
    });
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    await waitFor(() => expect(openTurnStream).toHaveBeenCalledWith("turn-1", expect.any(Object)));
    expect(screen.getByTestId("message-list").dataset.rowKeys).toContain("optimistic-1");
    rs.mocked(listSessionMessages).mockResolvedValue([
      {
        id: "server-input-1",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "user",
        content: JSON.stringify([{ type: "text", content: "Hello" }]),
        createdAt: "2026-09-30T14:00:00.000Z",
      },
      {
        id: "answer-1",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: "Done" }]),
        createdAt: "2026-09-30T14:00:01.000Z",
      },
    ]);
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");
    expect(screen.getByTestId("message-list").dataset.rowKeys).toContain("answer-1");
    expect(screen.getByTestId("message-list").dataset.rowKeys).not.toContain("optimistic-1");
  });

  it("keeps a foreground send live when its stream drops", async () => {
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    rs.mocked(postSessionTurn).mockResolvedValue({ ok: true, data: { turnId: "turn-local" } });
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    await waitFor(() =>
      expect(openTurnStream).toHaveBeenCalledWith("turn-local", expect.any(Object)),
    );

    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-local", status: "running" }]);
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("mobile connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("true");
    expect(screen.getByTestId("message-list").dataset.streaming).toBe("true");

    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(openTurnStream).toHaveBeenCalledTimes(2);
  });

  it("keeps the live turn and Stop visible while reconnecting after a mobile stream drop", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    await act(async () => {
      streamController!.enqueue(
        new TextEncoder().encode(
          'event: assistant_text\ndata: {"blockIx":0,"text":"Partial reply"}\n\n',
        ),
      );
    });
    expect(screen.getByTestId("message-list").dataset.liveText).toBe("Partial reply");

    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("mobile connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("true");
    expect(screen.getByTestId("message-list").dataset.streaming).toBe("true");
    expect(screen.getByTestId("message-list").dataset.liveText).toBe("Partial reply");
    expect(screen.getByTestId("stop-button")).toBeTruthy();

    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(openTurnStream).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("true");
    expect(screen.getByTestId("message-list").dataset.liveText).toBe("Partial reply");
  });

  it("offers a local reset after repeated inconclusive recovery checks", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    rs.mocked(listSessionTurns).mockResolvedValue(null);

    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(14_000);
    });

    expect(screen.getByTestId("recovery-notice")).toBeTruthy();
    expect(screen.getByTestId("stop-button")).toBeTruthy();
    const checksBeforeRetry = rs.mocked(listSessionTurns).mock.calls.length;
    fireEvent.click(screen.getByTestId("retry-recovery"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(rs.mocked(listSessionTurns).mock.calls.length).toBeGreaterThan(checksBeforeRetry);
    expect(screen.getByTestId("recovery-notice")).toBeTruthy();
    fireEvent.click(screen.getByTestId("reset-recovery"));
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");
    expect(screen.queryByTestId("recovery-notice")).toBeNull();

    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    const attachesBeforeRetry = rs.mocked(openTurnStream).mock.calls.length;
    await act(async () => {
      await rs.advanceTimersByTimeAsync(30_000);
    });
    expect(rs.mocked(openTurnStream).mock.calls.length).toBe(attachesBeforeRetry);
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");

    rs.mocked(listSessionTurns).mockResolvedValue([]);
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-2", status: "running" }]);
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(openTurnStream).toHaveBeenCalledWith("turn-2", expect.any(Object));
  });

  it("times out a stalled recovery lookup and keeps retry available", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    rs.mocked(listSessionTurns).mockImplementation(() => new Promise(() => {}));
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(45_000);
    });
    expect(listSessionTurns).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("recovery-notice")).toBeTruthy();
    expect(screen.getByTestId("stop-button")).toBeTruthy();
  });

  it("times out a stalled stream open without settling the live view", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream)
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
            }),
          ),
        ),
      )
      .mockImplementation(() => new Promise(() => {}));
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(16_000);
    });
    expect(openTurnStream).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("stop-button")).toBeTruthy();
  });

  it("retries recovery immediately when connectivity returns", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    rs.mocked(listSessionTurns).mockResolvedValue(null);
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(2_000);
    });
    const checksBeforeOnline = rs.mocked(listSessionTurns).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    expect(rs.mocked(listSessionTurns).mock.calls.length).toBeGreaterThan(checksBeforeOnline);
    expect(screen.getByTestId("stop-button")).toBeTruthy();

    const checksBeforeVisible = rs.mocked(listSessionTurns).mock.calls.length;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(rs.mocked(listSessionTurns).mock.calls.length).toBeGreaterThan(checksBeforeVisible);
  });

  it("allows a new accepted send to reattach a previously reset turn", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    rs.mocked(listSessionTurns).mockResolvedValue(null);
    rs.useFakeTimers();
    await act(async () => {
      controllers[0]!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(14_000);
    });
    fireEvent.click(screen.getByTestId("reset-recovery"));
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");

    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    rs.mocked(postSessionTurn).mockResolvedValue({ ok: true, data: { turnId: "turn-1" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(openTurnStream).toHaveBeenCalledTimes(2);
    await act(async () => {
      controllers[1]!.error(new Error("connection dropped again"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(openTurnStream).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("stop-button")).toBeTruthy();
  });

  it("keeps the reconnect error stable and backs off repeated attach failures", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream)
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
            }),
          ),
        ),
      )
      .mockResolvedValue(new Response(null, { status: 503 }));
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());

    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(openTurnStream).toHaveBeenCalledTimes(2);
    const firstError = screen.getByTestId("chat-composer").dataset.error;
    expect(firstError).toBe("stream.errors.reconnectStatus");

    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(openTurnStream).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("chat-composer").dataset.error).toBe(firstError);

    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(openTurnStream).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("chat-composer").dataset.error).toBe(firstError);

    rs.mocked(listSessionTurns).mockResolvedValue([]);
    await act(async () => {
      await rs.advanceTimersByTimeAsync(8_000);
    });
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");
    expect(screen.getByTestId("chat-composer").dataset.error).toBe("");
  });

  it("keeps reconnect errors visible while an accepted follow-up retries immediately", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream)
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
            }),
          ),
        ),
      )
      .mockResolvedValue(new Response(null, { status: 503 }));
    rs.mocked(postSessionTurn).mockResolvedValue({ ok: true, data: { turnId: "turn-2" } });
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(2_000);
    });
    const error = screen.getByTestId("chat-composer").dataset.error;
    expect(error).toBe("stream.errors.reconnectStatus");
    const checksBeforeSend = rs.mocked(listSessionTurns).mock.calls.length;
    fireEvent.click(screen.getByTestId("send-button"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rs.mocked(listSessionTurns).mock.calls.length).toBeGreaterThan(checksBeforeSend);
    expect(screen.getByTestId("chat-composer").dataset.error).toBe(error);
  });

  it("does not show a reconnect error for a stream-open 404 race", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream)
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
            }),
          ),
        ),
      )
      .mockResolvedValue(new Response(null, { status: 404 }));
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(openTurnStream).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("chat-composer").dataset.error).toBe("");
  });

  it("reports repeated HTTP-200 streams whose readers fail immediately", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream)
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
            }),
          ),
        ),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("reader failed"));
              },
            }),
          ),
        ),
      );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(14_000);
    });
    expect(openTurnStream).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("recovery-notice")).toBeTruthy();
    expect(screen.getByTestId("stop-button")).toBeTruthy();

    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start() {} }))),
    );
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(openTurnStream).toHaveBeenCalledTimes(5);
    expect(screen.queryByTestId("recovery-notice")).toBeNull();
    expect(screen.getByTestId("stop-button")).toBeTruthy();
  });

  it("returns idle polling to two seconds after a successful empty lookup", async () => {
    rs.mocked(listSessionTurns)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    rs.useFakeTimers();
    renderChat(<Chat sessionId="session-1" />);
    await act(async () => {
      await Promise.resolve();
      await rs.advanceTimersByTimeAsync(4_000);
    });
    expect(listSessionTurns).toHaveBeenCalledTimes(2);

    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(openTurnStream).toHaveBeenCalledWith("turn-1", expect.any(Object));
  });

  it("settles a dropped stream only after the server confirms the turn ended", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalled());
    const reloadsBeforeDrop = rs.mocked(listSessionMessages).mock.calls.length;

    rs.useFakeTimers();
    await act(async () => {
      streamController!.close();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listSessionMessages).toHaveBeenCalledTimes(reloadsBeforeDrop);
    rs.mocked(listSessionTurns).mockResolvedValue(null);
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("true");

    rs.mocked(listSessionTurns).mockResolvedValue([]);
    await act(async () => {
      await rs.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");
    expect(screen.getByTestId("message-list").dataset.streaming).toBe("false");
    expect(screen.queryByTestId("stop-button")).toBeNull();
    expect(rs.mocked(listSessionMessages).mock.calls.length).toBeGreaterThan(reloadsBeforeDrop);
  });

  it("clears recovery bookkeeping when Stop confirms a dropped turn ended", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId("stop-button")).toBeTruthy());
    rs.mocked(interruptTurn).mockResolvedValue(new Response(null, { status: 404 }));
    rs.mocked(listSessionTurns).mockResolvedValue([]);

    rs.useFakeTimers();
    await act(async () => {
      streamController!.error(new Error("connection dropped"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-button"));
      await rs.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("chat-composer").dataset.streaming).toBe("false");
    const reloadsAfterStop = rs.mocked(listSessionMessages).mock.calls.length;

    await act(async () => {
      await rs.advanceTimersByTimeAsync(2_000);
    });
    expect(listSessionMessages).toHaveBeenCalledTimes(reloadsAfterStop);
  });

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
