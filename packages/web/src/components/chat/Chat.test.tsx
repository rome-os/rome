// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, memo, useImperativeHandle, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as chatApiModule from "@/lib/chat-api" with { rstest: "importActual" };
import * as streamingSessionsModule from "@/hooks/use-streaming-sessions" with {
  rstest: "importActual",
};
import { requestConciergeJump } from "@/components/concierge/concierge-jump";
import { HOLD_STICK_EVENT } from "@/hooks/use-stick-to-bottom";
import { useReplyDraft } from "@/components/chat/reply/reply-draft";
import { ShareMessageButton } from "@/components/chat/ShareMessageButton";
import type { ConciergeActivity } from "@rome/api-types/concierge-activity";
import { SlotOutlet, SlotProvider, useSlotOutlet } from "@/components/slot";
import {
  CONCIERGE_LEADING_SLOT,
  CONCIERGE_TITLEBAR_SLOT,
} from "@/components/concierge/ConciergeHeaderStatus";
import { ToolTasksContext, type ToolTasksHost } from "@/pages/free/tool-tasks";
import { Chat } from "./Chat";
import enChat from "@/i18n/locales/en/chat.json";
import zhChat from "@/i18n/locales/zh-CN/chat.json";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import type { LiveEventsClient } from "@/lib/live-events";
import {
  acceptLatestSocket,
  FakeWebSocket,
  fakeSocketLiveEventsClient,
} from "@/test/fake-websocket";
import { applyAgentPlacement } from "@/pages/free/use-free-cells";
import { ToolTraceContext, type ToolTraceHost } from "@/pages/free/tool-trace";
import {
  createSession,
  deleteSession,
  interruptTurn,
  listSessionMessagePage,
  listSessionMessages,
  listSessionTurns,
  openTurnStream,
  postSessionTurn,
} from "@/lib/chat-api";

let agentRoleLabel = enChat.roles.agent;
const t = (key: string) => (key === "roles.agent" ? agentRoleLabel : key);
const mockUseSessionIdentity = rs.hoisted(() => rs.fn());
const appsPanel = rs.hoisted(() => ({ collapsed: true, setCollapsed: rs.fn() }));
const mockUseChatTabStatus = rs.hoisted(() => rs.fn());
const conciergeInsertText = rs.hoisted(() => rs.fn());
const conciergeAddFiles = rs.hoisted(() => rs.fn());
const toast = rs.hoisted(() => ({
  loading: rs.fn(() => "finding"),
  error: rs.fn(),
  dismiss: rs.fn(),
}));
rs.mock("sonner", () => ({ toast }));
// How often the chat and its composer render: the chat calls this hook once
// per render, and the composer stand-in counts its own.
const renders = rs.hoisted(() => ({ chat: 0, composer: 0 }));

rs.mock("@/hooks/use-streaming-sessions", () => ({
  ...streamingSessionsModule,
  useStreamingSessions: () => {
    renders.chat += 1;
    return streamingSessionsModule.useStreamingSessions();
  },
}));

rs.mock("@/hooks/use-tab-status", () => ({
  useChatTabStatus: mockUseChatTabStatus,
}));

// `initReactI18next` too: any module that loads the app's i18n setup passes
// it to `i18next.use()`, which throws on an undefined plugin.
rs.mock("react-i18next", () => ({
  useTranslation: () => ({ t }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: {
      kind: "visitor",
      accountId: "acct-ana",
      email: "ana@example.com",
      avatarUrl: "https://example.com/ana.png",
    },
  }),
}));

rs.mock("@/components/chat/use-session-identity", () => ({
  useSessionIdentity: mockUseSessionIdentity,
}));

// The activity and the task list are tested on their own; here only what the
// header shows of them.
const mockConciergeActivity = rs.hoisted(() => rs.fn((): ConciergeActivity => ({ kind: "idle" })));
rs.mock("@/components/concierge/use-concierge-activity", () => ({
  useConciergeActivity: mockConciergeActivity,
}));
const mockOpenTaskList = rs.hoisted(() => rs.fn());
rs.mock("@/components/concierge/TaskListPane", () => ({
  useTaskList: () => ({ open: mockOpenTaskList, sheet: null }),
}));

rs.mock("@/pages/free/workspace-context", () => ({
  snapshotWorkspaceForSend: () => null,
  useWorkspaceContextRegistry: () => null,
}));

rs.mock("@/pages/free/workspace-event-bus", () => ({
  useWorkspaceEventBus: () => null,
}));

rs.mock("@/pages/free/use-free-cells", () => ({
  applyAgentPlacement: rs.fn(),
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
  HOLD_STICK_EVENT: "rome:hold-stick",
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

rs.mock("@/components/agent-trace/TraceDrawer", () => ({
  TraceDrawer: ({
    target,
    outlet,
    onClose,
  }: {
    target: { kind: string } | null;
    outlet: HTMLElement | null;
    onClose: () => void;
  }) =>
    target ? (
      <button
        type="button"
        data-testid="trace-drawer"
        data-outlet={outlet ? "tab" : "pending"}
        onClick={onClose}
      >
        {target.kind}
      </button>
    ) : null,
}));

rs.mock("@/components/chat/AgentAvatar", () => ({
  AgentAvatar: () => null,
}));

rs.mock("@/components/chat/ShareBar", () => ({
  ShareBar: ({
    selectedTurnIds,
    agentName,
    onExit,
  }: {
    selectedTurnIds: string[];
    agentName?: string;
    onExit: () => void;
  }) => (
    <>
      <div data-testid="share-bar" data-agent-name={agentName}>
        {selectedTurnIds.join(",")}
      </div>
      <button type="button" data-testid="share-exit" onClick={onExit}>
        exit
      </button>
    </>
  ),
}));

rs.mock("@/pages/free/WidgetPicker", () => ({
  WidgetPicker: () => null,
}));

function ReplyJump() {
  const reply = useReplyDraft();
  return (
    <>
      <button type="button" data-testid="reply-jump" onClick={() => reply?.jump("a2")}>
        jump
      </button>
      <button
        type="button"
        data-testid="open-thread"
        onClick={() =>
          reply?.openThread({ messageId: "u-1", author: "guardian", preview: "First" })
        }
      >
        open thread
      </button>
      {/* An older thread message the timeline has not loaded, as the thread view draws it. */}
      <div data-testid="older-thread-message">
        <ShareMessageButton
          messageId="u-old"
          turn={{ sessionId: "session-1", turnId: "turn-old" }}
        />
      </div>
    </>
  );
}

rs.mock("@/components/chat/MessageList", () => ({
  MessageList: ({
    live,
    rows,
    onOpenStoredTrace,
  }: {
    onOpenStoredTrace: (target: unknown) => void;
    live: {
      identity: { name: string };
      snapshot: { segments: unknown[]; summary: { totalSteps: number } } | null;
    };
    rows: {
      kind: string;
      key: string;
      message?: {
        id?: string;
        content: string;
        traceArchived?: boolean;
        sender?: { name: string | null; avatarUrl?: string | null; onBehalfOf?: { kind: string } };
      };
    }[];
  }) => (
    <>
      <div data-testid="message-list">{live.identity.name}</div>
      {live.snapshot ? (
        <div
          data-testid="live-snapshot"
          data-steps={live.snapshot.summary.totalSteps}
          data-segments={live.snapshot.segments.length}
        />
      ) : null}
      <div data-testid="agent-anchor" data-timeline-anchor="a1 a2" />
      <ReplyJump />
      <button
        type="button"
        onClick={() =>
          onOpenStoredTrace({
            kind: "stored",
            messageId: "trace-1",
            sessionId: "session-1",
            turnId: "turn-1",
            summary: { distinctApps: [], totalSteps: 1, invocationCounts: {} },
          })
        }
      >
        open stored trace
      </button>
      {rows
        .filter((row) => row.kind === "user")
        .map((row) => (
          <div
            key={row.key}
            data-testid="user-row"
            data-row-key={row.key}
            data-timeline-anchor={row.message?.id}
            data-sender={row.message?.sender?.name}
            data-on-behalf={row.message?.sender?.onBehalfOf?.kind}
            data-sender-avatar={row.message?.sender?.avatarUrl}
          >
            {row.message?.content}
            {row.message?.id ? <ShareMessageButton messageId={row.message.id} /> : null}
          </div>
        ))}
      {rows
        .filter((row) => row.kind === "trace")
        .map((row) => (
          <div
            key={row.key}
            data-testid="trace-row"
            data-row-key={row.key}
            data-archived={row.message?.traceArchived}
          />
        ))}
    </>
  ),
}));

rs.mock("@/components/chat/ChatComposer", () => ({
  // Expose the streaming state + Stop wiring so tests can drive stopMessage
  // the way the real composer's Stop button does.
  // Memoized, as the real one is: it renders again only for new props.
  ChatComposer: memo(function ChatComposer(props: {
    isStreaming?: boolean;
    onStop?: () => void;
    onSend?: (snapshot: unknown, controls: unknown) => Promise<void>;
    streamError?: string | { message: string } | null;
  }) {
    renders.composer += 1;
    return (
      <div data-testid="chat-composer" data-streaming={props.isStreaming ? "true" : "false"}>
        {props.streamError ? (
          <div data-testid="stream-error">
            {typeof props.streamError === "string" ? props.streamError : props.streamError.message}
          </div>
        ) : null}
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
        {props.onSend ? (
          <button
            type="button"
            data-testid="send-reply-button"
            onClick={() =>
              void props
                .onSend?.(
                  {
                    text: "and then?",
                    uploads: [],
                    reasoningEffort: "medium",
                    projectPath: "",
                    inputId: "11111111-1111-4111-8111-111111111111",
                    replyTo: {
                      messageId: "a2",
                      author: "agent",
                      quote: "Lisbon",
                      preview: "Lisbon",
                    },
                  },
                  { onUploadProgress: () => {}, signal: new AbortController().signal },
                )
                .catch(() => {})
            }
          />
        ) : null}
        {props.onSend ? (
          <button
            type="button"
            data-testid="send-text-button"
            onClick={() =>
              void props
                .onSend?.(
                  {
                    text: "sent at once",
                    uploads: [],
                    reasoningEffort: "medium",
                    projectPath: "",
                    inputId: "11111111-1111-4111-8111-111111111111",
                  },
                  { onUploadProgress: () => {}, signal: new AbortController().signal },
                )
                .catch(() => {})
            }
          />
        ) : null}
      </div>
    );
  }),
}));

// Concierge's composer: records programmatic fills and sends a fixed message.
rs.mock("@/components/chat/composer/ConciergeComposer", () => ({
  ConciergeComposer: forwardRef(function ConciergeComposer(
    props: {
      onSend?: (snapshot: unknown, controls: unknown) => Promise<void>;
      isStreaming?: boolean;
      onStop?: () => void;
      chatName?: string | null;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      insertText: conciergeInsertText,
      addFiles: conciergeAddFiles,
      focus: () => {},
    }));
    return (
      <div
        data-testid="chat-composer"
        data-streaming={props.isStreaming ? "true" : "false"}
        data-chat-name={props.chatName ?? ""}
      >
        <button
          type="button"
          data-testid="concierge-send-button"
          onClick={() =>
            void props
              .onSend?.(
                {
                  text: "sent at once",
                  uploads: [],
                  reasoningEffort: "medium",
                  projectPath: "",
                  inputId: "11111111-1111-4111-8111-111111111111",
                },
                { onUploadProgress: () => {}, signal: new AbortController().signal },
              )
              .catch(() => {})
          }
        />
        {props.isStreaming && props.onStop ? (
          <button type="button" data-testid="stop-button" onClick={props.onStop} />
        ) : null}
      </div>
    );
  }),
}));

rs.mock("@/components/chat/entries", () => ({
  renderFlatEntries: () => null,
  renderSingleEntry: () => null,
}));

rs.mock("@/lib/chat-api", () => {
  const listSessionMessages = rs.fn().mockResolvedValue([]);
  return {
    ...chatApiModule,
    createSession: rs.fn(),
    deleteSession: rs.fn(),
    interruptTurn: rs.fn(),
    listSessionMessages,
    // The newest page reads like the whole list unless a test says otherwise.
    listSessionMessagePage: rs.fn(async (id: string) => {
      const all = await listSessionMessages(id);
      return all === null ? null : { messages: all, nextCursor: null };
    }),
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

// A stand-in tool pane that follows the mocked saved pane state. A test that
// supplies its own provider inside `children` overrides it.
function pane(children: ReactNode) {
  const host: ToolTraceHost = {
    outlet: null,
    paneOpen: !appsPanel.collapsed,
    setPaneCollapsed: appsPanel.setCollapsed,
    reveal: rs.fn(),
    set: rs.fn(),
  };
  return <ToolTraceContext.Provider value={host}>{children}</ToolTraceContext.Provider>;
}

/** A query client as the app gives every chat: the Concierge chat reads its task list through it. */
const queries = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** Wraps what a test renders, and every rerender of it, in a query client of its own. */
function withQueries() {
  const client = queries();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function renderChat(children: ReactNode, live?: LiveEventsClient) {
  const routed = <MemoryRouter>{pane(children)}</MemoryRouter>;
  return render(
    live ? (
      <LiveEventsClientContext.Provider value={live}>{routed}</LiveEventsClientContext.Provider>
    ) : (
      routed
    ),
    { wrapper: withQueries() },
  );
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
  mockConciergeActivity.mockReturnValue({ kind: "idle" });
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

describe("Chat missing-session detection", () => {
  it("reports a confirmed missing session", async () => {
    rs.mocked(listSessionMessages).mockResolvedValueOnce(null);
    const onSessionNotFound = rs.fn();
    renderChat(<Chat sessionId="missing" onSessionNotFound={onSessionNotFound} />);

    await waitFor(() => expect(onSessionNotFound).toHaveBeenCalledWith("missing"));
  });

  it("does not report a temporary fetch failure as a missing session", async () => {
    rs.mocked(listSessionMessages).mockRejectedValueOnce(new Error("Service unavailable"));
    const onSessionNotFound = rs.fn();
    await act(async () => {
      renderChat(<Chat sessionId="session-1" onSessionNotFound={onSessionNotFound} />);
    });

    expect(listSessionMessages).toHaveBeenCalledWith("session-1");
    expect(onSessionNotFound).not.toHaveBeenCalled();
  });

  it("ignores a late missing-session response after leaving the chat", async () => {
    let resolveMessages!: (value: null) => void;
    rs.mocked(listSessionMessages).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMessages = resolve;
        }),
    );
    const onSessionNotFound = rs.fn();
    const { unmount } = renderChat(
      <Chat sessionId="missing" onSessionNotFound={onSessionNotFound} />,
    );
    unmount();

    await act(async () => resolveMessages(null));

    expect(onSessionNotFound).not.toHaveBeenCalled();
  });
});

describe("Chat trace in the tool pane", () => {
  function host(outlet: HTMLElement | null = null) {
    return {
      outlet,
      paneOpen: true,
      setPaneCollapsed: rs.fn(),
      reveal: rs.fn(),
      set: rs.fn(),
    } satisfies ToolTraceHost;
  }
  const withHost = (toolTrace: ToolTraceHost, element: ReactNode) => (
    <ToolTraceContext.Provider value={toolTrace}>{element}</ToolTraceContext.Provider>
  );

  it("reveals the Trace tab and registers the open trace with the pane", async () => {
    const user = userEvent.setup();
    const toolTrace = host();
    renderChat(withHost(toolTrace, <Chat sessionId="session-1" />));
    expect(toolTrace.set).toHaveBeenLastCalledWith(expect.any(String), null);
    expect(toolTrace.reveal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "open stored trace" }));
    expect(toolTrace.reveal).toHaveBeenCalledTimes(1);
    expect(toolTrace.set).toHaveBeenLastCalledWith(expect.any(String), {
      streaming: false,
      onClose: expect.any(Function),
    });
    // The pane draws the trace, so the chat no longer reserves room for a drawer.
    expect(screen.getByTestId("trace-drawer").getAttribute("data-outlet")).toBe("pending");
  });

  it("shows the expand control from the pane's open state, which counts a trace-held pane", async () => {
    const user = userEvent.setup();
    const toolTrace = { ...host(), paneOpen: false };
    const { rerender } = renderChat(withHost(toolTrace, <Chat sessionId="session-1" />));
    await user.click(screen.getByRole("button", { name: "chat.expandTools" }));
    expect(toolTrace.setPaneCollapsed).toHaveBeenCalledWith(false);

    rerender(
      <MemoryRouter>
        {withHost({ ...toolTrace, paneOpen: true }, <Chat sessionId="session-1" />)}
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: "chat.expandTools" })).toBeNull();
  });

  it("hands the pane's outlet to the drawer", async () => {
    const user = userEvent.setup();
    const outlet = document.createElement("div");
    renderChat(withHost(host(outlet), <Chat sessionId="session-1" />));
    await user.click(screen.getByRole("button", { name: "open stored trace" }));
    expect(screen.getByTestId("trace-drawer").getAttribute("data-outlet")).toBe("tab");
  });

  it("closes the trace when the pane's tab asks to close", async () => {
    const user = userEvent.setup();
    const toolTrace = host();
    renderChat(withHost(toolTrace, <Chat sessionId="session-1" />));
    await user.click(screen.getByRole("button", { name: "open stored trace" }));
    const tab = toolTrace.set.mock.calls.at(-1)?.[1] as { onClose: () => void };
    act(() => tab.onClose());

    expect(screen.queryByTestId("trace-drawer")).toBeNull();
    expect(toolTrace.set).toHaveBeenLastCalledWith(expect.any(String), null);
  });

  it("removes the tab when the chat goes away", async () => {
    const user = userEvent.setup();
    const toolTrace = host();
    const { unmount } = renderChat(withHost(toolTrace, <Chat sessionId="session-1" />));
    await user.click(screen.getByRole("button", { name: "open stored trace" }));
    unmount();
    expect(toolTrace.set).toHaveBeenLastCalledWith(expect.any(String), null);
  });
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
    rerender(<MemoryRouter>{pane(<Chat sessionId="session-1" />)}</MemoryRouter>);
    expect(screen.queryByRole("button", { name: "chat.expandTools" })).toBeNull();
    appsPanel.collapsed = true;
    rerender(<MemoryRouter>{pane(<Chat sessionId="session-1" />)}</MemoryRouter>);
    expect(screen.getByRole("button", { name: "chat.expandTools" })).toBeTruthy();
  });

  it("marks the header avatar with the session model's vendor", () => {
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "A conversation",
      model: "gpt-5.5",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(<Chat sessionId="session-1" />);
    const avatar = screen.getByRole("button", { name: "navbar.sessionModel" });
    expect(avatar.querySelector('svg[aria-label="ChatGPT"]')).toBeTruthy();
  });

  it("names the effort the session's last turn ran with", () => {
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "A conversation",
      model: "gpt-5.5",
      reasoningEffort: "max",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(<Chat sessionId="session-1" />);
    expect(screen.getByRole("button", { name: "navbar.sessionModelWithEffort" })).toBeTruthy();
  });

  it("shows a spinner and Loading… instead of New Chat while an existing session loads", () => {
    mockUseSessionIdentity.mockReturnValue({
      loading: true,
      sessionName: null,
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(<Chat sessionId="session-1" />);
    expect(screen.getByRole("status", { name: "sidebar.loading" })).toBeTruthy();
    expect(screen.getByText("sidebar.loading")).toBeTruthy();
    expect(screen.queryByText("sidebar.newChat")).toBeNull();
  });

  it("shows no loading title for a draft chat without a session", () => {
    renderChat(<Chat />);
    expect(screen.queryByRole("status", { name: "sidebar.loading" })).toBeNull();
    expect(screen.queryByText("sidebar.loading")).toBeNull();
  });

  it("shows the session name once loaded, and New Chat for a loaded unnamed session", () => {
    mockUseSessionIdentity.mockReturnValue({
      loading: false,
      sessionName: "A conversation",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    const { unmount } = renderChat(<Chat sessionId="session-1" />);
    expect(screen.getByText("A conversation")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "sidebar.loading" })).toBeNull();
    unmount();

    mockUseSessionIdentity.mockReturnValue({
      loading: false,
      sessionName: "  ",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(<Chat sessionId="session-1" />);
    expect(screen.getByText("sidebar.newChat")).toBeTruthy();
  });

  it("does not invent a model for a session without a pin", () => {
    renderChat(<Chat sessionId="session-1" />);
    expect(screen.queryByLabelText("navbar.sessionModel")).toBeNull();
  });

  it.each([
    ["en", enChat.roles.agent],
    ["zh-CN", zhChat.roles.agent],
  ])("names an unnamed main agent Rome in %s ordinary replies", (_locale, label) => {
    agentRoleLabel = label;
    try {
      renderChat(<Chat sessionId="session-1" mainAgentDisplayName="  " />);
      expect(screen.getByTestId("message-list").textContent).toBe("Rome");
    } finally {
      agentRoleLabel = enChat.roles.agent;
    }
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
  const archivedTrace = {
    id: "old-trace",
    sessionId: "session-1",
    turnId: "old-turn",
    role: "trace" as const,
    content: "[]",
    createdAt: "2026-09-24T12:00:00Z",
    traceArchived: true,
  };
  const restoredTrace = {
    ...archivedTrace,
    traceArchived: undefined,
    traceSummary: { distinctApps: [], totalSteps: 1, invocationCounts: {} },
  };

  it.each([
    "user",
    "assistant",
    "trace",
    "notification",
  ])("reloads archived turns immediately when a %s message arrives", async (role) => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    rs.mocked(listSessionMessages)
      .mockResolvedValueOnce([archivedTrace])
      .mockResolvedValueOnce([restoredTrace]);
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("trace-row").getAttribute("data-archived")).toBe("true"),
    );
    act(() =>
      MockEventSource.instances[0]?.emit("message_insert", {
        id: "new-message",
        sessionId: "session-1",
        turnId: "new-turn",
        role,
        content: "[]",
        createdAt: "2026-10-24T12:00:00Z",
      }),
    );
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getAllByTestId("trace-row")[0]?.getAttribute("data-archived")).toBeNull(),
    );
  });

  it("reloads archived turns on send acceptance without waiting for a message event or completed turn", async () => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    rs.mocked(listSessionMessages)
      .mockResolvedValueOnce([archivedTrace])
      .mockResolvedValueOnce([restoredTrace]);
    rs.mocked(postSessionTurn).mockResolvedValueOnce({ ok: true, data: { turnId: "turn-1" } });
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("trace-row").getAttribute("data-archived")).toBe("true"),
    );
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("trace-row").getAttribute("data-archived")).toBeNull(),
    );
  });

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

describe("Chat history paging", () => {
  const userMessage = (n: number) => ({
    id: `user-${n}`,
    sessionId: "session-1",
    turnId: `turn-${n}`,
    role: "user" as const,
    content: `question ${n}`,
    createdAt: new Date(Date.UTC(2026, 9, 27, 12, n)).toISOString(),
  });
  const shownKeys = () => screen.getAllByTestId("user-row").map((row) => row.dataset.rowKey);
  let observers: Array<{ report: () => void; disconnected: boolean }> = [];

  class FakeIntersectionObserver {
    entry = { disconnected: false, report: () => {} };
    constructor(callback: IntersectionObserverCallback) {
      this.entry.report = () =>
        callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never);
      observers.push(this.entry);
    }
    observe() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
    disconnect() {
      this.entry.disconnected = true;
    }
  }
  const reachTop = () =>
    act(async () =>
      observers
        .filter((o) => !o.disconnected)
        .at(-1)
        ?.report(),
    );

  beforeEach(() => {
    observers = [];
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    rs.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  it("opens on the newest page and pages older turns in above it", async () => {
    rs.mocked(listSessionMessagePage)
      .mockResolvedValueOnce({ messages: [userMessage(3), userMessage(4)], nextCursor: "c1" })
      .mockResolvedValueOnce({ messages: [userMessage(1), userMessage(2)], nextCursor: null });
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(shownKeys()).toEqual(["user-3", "user-4"]));

    await reachTop();

    await waitFor(() => expect(shownKeys()).toEqual(["user-1", "user-2", "user-3", "user-4"]));
    expect(rs.mocked(listSessionMessagePage).mock.calls[1]).toEqual([
      "session-1",
      { limit: expect.any(Number), before: "c1" },
    ]);
  });

  it("keeps the older pages when a reconnect refetches the newest one", async () => {
    rs.mocked(listSessionMessagePage)
      .mockResolvedValueOnce({ messages: [userMessage(3), userMessage(4)], nextCursor: "c1" })
      .mockResolvedValueOnce({ messages: [userMessage(1), userMessage(2)], nextCursor: null })
      .mockResolvedValueOnce({
        messages: [userMessage(3), userMessage(4), userMessage(5)],
        nextCursor: "c1",
      });
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(shownKeys()).toEqual(["user-3", "user-4"]));
    await reachTop();
    await waitFor(() => expect(shownKeys()).toHaveLength(4));
    const source = MockEventSource.instances[0]!;

    act(() => source.emitLifecycle("error", MockEventSource.CLOSED));

    await waitFor(() =>
      expect(shownKeys()).toEqual(["user-1", "user-2", "user-3", "user-4", "user-5"]),
    );
    expect(rs.mocked(listSessionMessagePage).mock.calls[2]).toEqual([
      "session-1",
      { limit: expect.any(Number) },
    ]);
  });

  it("starts over from the newest page when a reconnect finds a gap behind it", async () => {
    rs.mocked(listSessionMessagePage)
      .mockResolvedValueOnce({ messages: [userMessage(3), userMessage(4)], nextCursor: "c1" })
      .mockResolvedValueOnce({ messages: [userMessage(8), userMessage(9)], nextCursor: "c9" })
      .mockResolvedValueOnce({ messages: [userMessage(6), userMessage(7)], nextCursor: null });
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(shownKeys()).toEqual(["user-3", "user-4"]));
    const source = MockEventSource.instances[0]!;

    act(() => source.emitLifecycle("error", MockEventSource.CLOSED));
    await waitFor(() => expect(shownKeys()).toEqual(["user-8", "user-9"]));
    await reachTop();

    await waitFor(() => expect(shownKeys()).toEqual(["user-6", "user-7", "user-8", "user-9"]));
    expect(rs.mocked(listSessionMessagePage).mock.calls[2]?.[1]).toMatchObject({ before: "c9" });
  });

  it("hands the first page's layout to the host once, not an older page's or a refetch's", async () => {
    const layout = [{ id: "files", type: "projects", order: 0 }];
    rs.mocked(listSessionMessagePage)
      .mockResolvedValueOnce({
        messages: [userMessage(3), userMessage(4)],
        nextCursor: "c1",
        layout,
      })
      .mockResolvedValueOnce({ messages: [userMessage(1), userMessage(2)], nextCursor: null })
      .mockResolvedValueOnce({
        messages: [userMessage(3), userMessage(4)],
        nextCursor: "c1",
        layout: [],
      });
    const onSessionLayout = rs.fn();
    renderChat(<Chat sessionId="session-1" onSessionLayout={onSessionLayout} />);
    await waitFor(() => expect(shownKeys()).toEqual(["user-3", "user-4"]));
    expect(onSessionLayout).toHaveBeenCalledWith("session-1", layout);

    await reachTop();
    await waitFor(() => expect(shownKeys()).toHaveLength(4));
    act(() => MockEventSource.instances[0]!.emitLifecycle("error", MockEventSource.CLOSED));
    await waitFor(() => expect(listSessionMessagePage).toHaveBeenCalledTimes(3));

    expect(onSessionLayout).toHaveBeenCalledTimes(1);
  });
});

describe("Chat session recovery", () => {
  it("asks the host to recover a missing session and loads it again", async () => {
    rs.mocked(listSessionMessagePage)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ messages: [], nextCursor: null });
    const recoverMissingSession = rs.fn().mockResolvedValue(true);
    const onSessionNotFound = rs.fn();

    renderChat(
      <Chat
        sessionId="concierge"
        recoverMissingSession={recoverMissingSession}
        onSessionNotFound={onSessionNotFound}
      />,
    );

    await waitFor(() => expect(listSessionMessagePage).toHaveBeenCalledTimes(2));
    expect(recoverMissingSession).toHaveBeenCalledWith("concierge");
    expect(onSessionNotFound).not.toHaveBeenCalled();
  });

  it("reports the session missing when it cannot be recovered", async () => {
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce(null);
    const onSessionNotFound = rs.fn();

    renderChat(
      <Chat
        sessionId="concierge"
        recoverMissingSession={rs.fn().mockResolvedValue(false)}
        onSessionNotFound={onSessionNotFound}
      />,
    );

    await waitFor(() => expect(onSessionNotFound).toHaveBeenCalledWith("concierge"));
    expect(listSessionMessagePage).toHaveBeenCalledTimes(1);
  });
});

describe("Chat session events over the live-events socket", () => {
  const sessionTopic = "chat.session:session-1";
  const sessionEvent = (socket: FakeWebSocket, event: string, data: unknown) =>
    act(() => socket.receive({ type: "event", topic: sessionTopic, event, data }));
  const accept = () => {
    let socket!: FakeWebSocket;
    act(() => {
      socket = acceptLatestSocket();
    });
    return socket;
  };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  });

  it("subscribes to the session topic and delivers inserted messages and names, with no EventSource", async () => {
    const onSessionMessage = rs.fn();
    const onSessionsChanged = rs.fn();
    renderChat(
      <Chat
        sessionId="session-1"
        onSessionMessage={onSessionMessage}
        onSessionsChanged={onSessionsChanged}
      />,
      fakeSocketLiveEventsClient(),
    );
    const socket = accept();
    expect(socket.sent).toEqual([{ type: "subscribe", topic: sessionTopic }]);

    sessionEvent(socket, "message_insert", {
      id: "message-1",
      sessionId: "session-1",
      turnId: "turn-2",
      role: "assistant",
      content: "[]",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    expect(onSessionMessage).toHaveBeenCalledWith({ sessionId: "session-1", turnId: "turn-2" });

    onSessionsChanged.mockClear();
    sessionEvent(socket, "session_name", { sessionId: "session-1", name: "Q4 Launch Plan" });
    expect(onSessionsChanged).toHaveBeenCalledOnce();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("resyncs messages once resubscribed after a drop, and when the server refuses the topic", async () => {
    renderChat(<Chat sessionId="session-1" />, fakeSocketLiveEventsClient());
    const first = accept();
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalled());
    rs.mocked(listSessionMessages).mockClear();

    act(() => first.close());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const second = FakeWebSocket.latest();
    act(() => second.open());
    expect(listSessionMessages).not.toHaveBeenCalled();
    act(() => second.receive({ type: "subscribed", topic: sessionTopic }));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());

    rs.mocked(listSessionMessages).mockClear();
    act(() => second.receive({ type: "error", topic: sessionTopic, message: "Not found" }));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());
  });
});

describe("Chat turn poll", () => {
  const sessionTopic = "chat.session:session-1";
  const flush = (ms = 0) =>
    act(async () => {
      await rs.advanceTimersByTimeAsync(ms);
    });
  const turnLookups = () => rs.mocked(listSessionTurns).mock.calls.length;
  const renderIdle = async () => {
    renderChat(<Chat sessionId="session-1" />, fakeSocketLiveEventsClient());
    let socket!: FakeWebSocket;
    act(() => {
      socket = acceptLatestSocket();
    });
    await flush();
    return socket;
  };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    rs.useFakeTimers();
  });

  afterEach(() => {
    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    rs.mocked(listSessionMessages).mockResolvedValue([]);
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it("asks an idle chat for its turns twice a minute, not every 2 s", async () => {
    await renderIdle();
    expect(turnLookups()).toBe(1);
    await flush(60_000);
    expect(turnLookups()).toBe(3);
  });

  it("stops asking while the tab is hidden and asks again as it is shown", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await renderIdle();
    await flush(120_000);
    expect(turnLookups()).toBe(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(turnLookups()).toBe(2);
  });

  it("follows a turn as soon as the chat's topic says one is running", async () => {
    const socket = await renderIdle();
    const event = (data: unknown) =>
      act(() =>
        socket.receive({ type: "event", topic: sessionTopic, event: "session_running", data }),
      );
    event({ sessionId: "session-1", running: false });
    await flush();
    expect(turnLookups()).toBe(1);

    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-9", status: "running" }]);
    event({ sessionId: "session-1", running: true });
    await flush();
    expect(turnLookups()).toBe(2);
    expect(rs.mocked(openTurnStream).mock.calls.map(([turnId]) => turnId)).toEqual(["turn-9"]);
    expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("true");
  });

  it.each([
    false,
    true,
  ])("loads a remote automated input before its reply ends, on behalf: %s", async (onBehalf) => {
    const socket = await renderIdle();
    let loaded!: (messages: import("@/lib/chat-types").ChatMessage[]) => void;
    rs.mocked(listSessionMessages).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    );
    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "remote-turn", status: "running" }]);
    rs.mocked(openTurnStream).mockImplementationOnce(
      async (_id, signal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: input_status\ndata: {"type":"input_status","inputId":"remote-input","turnId":"remote-turn","state":"accepted"}\n\n',
                ),
              );
              signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
        ),
    );
    act(() =>
      socket.receive({
        type: "event",
        topic: sessionTopic,
        event: "session_running",
        data: { sessionId: "session-1", running: true },
      }),
    );
    await flush();
    expect(listSessionMessages).toHaveBeenCalledTimes(2);
    // While the read is pending, no sender-less own-message placeholder is painted.
    expect(screen.queryByTestId("user-row")).toBeNull();
    await act(async () =>
      loaded([
        {
          id: "remote-input",
          sessionId: "session-1",
          turnId: "remote-turn",
          role: "user",
          createdAt: "2026-10-24T12:00:00Z",
          content: "Remote input",
          sender: {
            kind: "automated",
            sourceType: "app",
            name: "Daily Report",
            iconUrl: null,
            ...(onBehalf ? { onBehalfOf: { kind: "guardian", name: "Ray", avatarUrl: null } } : {}),
          },
        },
      ]),
    );
    await flush();
    expect(screen.getByTestId("user-row").getAttribute("data-sender")).toBe("Daily Report");
    expect(screen.getByTestId("user-row").getAttribute("data-on-behalf")).toBe(
      onBehalf ? "guardian" : null,
    );
    expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("true");
  });

  it("keeps the saved trace summary on the live entry while reattaching, then lets the replay update it", async () => {
    // The turn's saved trace is already in the transcript when the poll reattaches.
    rs.mocked(listSessionMessages).mockResolvedValue([
      {
        id: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "trace",
        createdAt: "2026-10-24T12:00:00Z",
        content: "",
        traceSummary: { distinctApps: [], totalSteps: 3, invocationCounts: {} },
      },
    ]);
    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    rs.mocked(openTurnStream).mockImplementationOnce(
      async (_id, signal) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
        ),
    );
    await renderIdle();
    await flush();

    // Reattached, nothing replayed yet: the live entry carries the saved summary
    // rather than an empty snapshot, so the bubble never flashes "0 steps".
    const snapshot = () => screen.getByTestId("live-snapshot");
    expect(snapshot().getAttribute("data-steps")).toBe("3");
    expect(snapshot().getAttribute("data-segments")).toBe("0");

    // A replayed segment lands before any summary_update: the summary stays put.
    const send = (chunk: string) =>
      act(async () => stream.enqueue(new TextEncoder().encode(chunk)));
    await send(
      'event: segment_upsert\ndata: {"id":"seg-1","ordinal":0,"kind":"block","block":{"type":"thinking","content":"x"}}\n\n',
    );
    await flush();
    expect(snapshot().getAttribute("data-steps")).toBe("3");
    expect(snapshot().getAttribute("data-segments")).toBe("1");

    // The replayed summary replaces the saved one.
    await send(
      'event: summary_update\ndata: {"distinctApps":[],"totalSteps":4,"invocationCounts":{}}\n\n',
    );
    await flush();
    expect(snapshot().getAttribute("data-steps")).toBe("4");
  });

  it("asks for the turns again once the socket comes back", async () => {
    const socket = await renderIdle();
    act(() => socket.close());
    await flush(100);
    act(() => {
      acceptLatestSocket();
    });
    await flush();
    expect(turnLookups()).toBe(2);
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

    it("passes each widget placement's id through, so the layout can skip a replay", async () => {
      const placement = (data: Record<string, unknown>) =>
        `event: widget_placement\ndata: ${JSON.stringify(data)}\n\n`;
      rs.mocked(openTurnStream)
        .mockImplementationOnce(() =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  droppingStreams.push(controller);
                  controller.enqueue(
                    encoder.encode(
                      placement({ placementId: "place-live", appId: "notes", route: "list" }),
                    ),
                  );
                },
              }),
            ),
          ),
        )
        .mockImplementationOnce(() =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(
                      // The replay of the placement already mounted, then a
                      // fresh placement of the same route, then one from a
                      // server that sends no id.
                      placement({ placementId: "place-live", appId: "notes", route: "list" }) +
                        placement({ placementId: "place-again", appId: "notes", route: "list" }) +
                        placement({ appId: "notes", route: "legacy" }) +
                        'event: done\ndata: {"success":true}\n\n',
                    ),
                  );
                  controller.close();
                },
              }),
            ),
          ),
        );
      renderChat(<Chat sessionId="session-1" />);
      await waitFor(() => expect(applyAgentPlacement).toHaveBeenCalledTimes(1));

      await act(async () => {
        droppingStreams[0]!.error(new TypeError("network connection was lost"));
      });
      await waitFor(() => expect(openTurnStream).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      await waitFor(() =>
        expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("false"),
      );
      expect(rs.mocked(applyAgentPlacement).mock.calls).toEqual([
        ["place-live", "notes", "list", undefined],
        ["place-live", "notes", "list", undefined],
        ["place-again", "notes", "list", undefined],
        [undefined, "notes", "legacy", undefined],
      ]);
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

  it("keeps a message sent while a turn's closing refetch is on the way", async () => {
    // The first turn ends at once, so its follower refetches the chat and
    // drops the local rows that page stands in for.
    rs.mocked(postSessionTurn).mockResolvedValueOnce({ ok: true, data: { turnId: "turn-1" } });
    rs.mocked(openTurnStream).mockImplementationOnce(
      async () => new Response(null, { status: 404 }),
    );
    let resolveRefetch!: (messages: import("@/lib/chat-types").ChatMessage[]) => void;
    rs.mocked(listSessionMessages)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRefetch = resolve)));
    // The second send stays unaccepted, so only its local row shows it.
    rs.mocked(postSessionTurn).mockImplementationOnce(() => new Promise(() => {}));
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(2));
    // Sent while that page is on the way, which was read before it existed.
    fireEvent.click(screen.getByTestId("send-text-button"));
    await screen.findByText("sent at once", { exact: false });
    await act(async () => {
      resolveRefetch([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const rows = screen.getAllByTestId("user-row").map((row) => row.dataset.rowKey);
    expect(rows).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("shows a text-only send before the server accepts it, under the same id", async () => {
    let resolvePost!: (result: Awaited<ReturnType<typeof postSessionTurn>>) => void;
    rs.mocked(postSessionTurn).mockImplementationOnce(
      () => new Promise((resolve) => (resolvePost = resolve)),
    );
    renderChat(<Chat sessionId="session-1" />);

    fireEvent.click(screen.getByTestId("send-text-button"));
    const bubble = await screen.findByTestId("user-row");
    expect(bubble.dataset.rowKey).toBe("11111111-1111-4111-8111-111111111111");
    expect(bubble.textContent).toContain("sent at once");
    expect(postSessionTurn).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePost({
        ok: true,
        data: {
          turnId: "turn-1",
          inputId: "11111111-1111-4111-8111-111111111111",
          inputState: "submitted",
        },
      });
    });

    expect(screen.getAllByTestId("user-row")).toHaveLength(1);
    expect(screen.getByTestId("user-row")).toBe(bubble);
  });

  it("posts the reply and its quote, and shows the quote in the early bubble", async () => {
    rs.mocked(postSessionTurn).mockImplementationOnce(() => new Promise(() => {}));
    renderChat(<Chat sessionId="session-1" />);

    fireEvent.click(screen.getByTestId("send-reply-button"));

    const early = await screen.findByTestId("user-row");
    expect(JSON.parse(early.textContent ?? "[]")).toEqual([
      { type: "reply_to", messageId: "a2", author: "agent", text: "Lisbon" },
      { type: "text", content: "and then?" },
    ]);
    const form = rs.mocked(postSessionTurn).mock.calls[0][1] as FormData;
    expect(form.get("replyToMessageId")).toBe("a2");
    expect(form.get("replyQuote")).toBe("Lisbon");
  });

  it("jumps to an agent turn by any of its message ids and tints it", async () => {
    // jsdom has no layout, so Element has no scrollTo to call.
    const scrollTo = rs.fn();
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = scrollTo as typeof Element.prototype.scrollTo;
    try {
      renderChat(<Chat sessionId="session-1" />);

      fireEvent.click(screen.getByTestId("reply-jump"));

      expect(scrollTo).toHaveBeenCalledOnce();
      expect(screen.getByTestId("agent-anchor").hasAttribute("data-timeline-landed")).toBe(true);
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it("shows the signed-in person as the sender of a message they send", async () => {
    let resolvePost!: (result: Awaited<ReturnType<typeof postSessionTurn>>) => void;
    rs.mocked(postSessionTurn).mockImplementationOnce(
      () => new Promise((resolve) => (resolvePost = resolve)),
    );
    renderChat(<Chat sessionId="session-1" />);

    fireEvent.click(screen.getByTestId("send-text-button"));
    const early = await screen.findByTestId("user-row");
    expect(early.dataset.sender).toBe("ana@example.com");
    expect(early.dataset.senderAvatar).toBe("https://example.com/ana.png");

    await act(async () => {
      resolvePost({
        ok: true,
        data: {
          turnId: "turn-1",
          inputId: "11111111-1111-4111-8111-111111111111",
          inputState: "submitted",
        },
      });
    });
    expect(screen.getByTestId("user-row").dataset.sender).toBe("ana@example.com");
  });

  it("takes the early bubble back down when the send is refused", async () => {
    let resolvePost!: (result: Awaited<ReturnType<typeof postSessionTurn>>) => void;
    rs.mocked(postSessionTurn).mockImplementationOnce(
      () => new Promise((resolve) => (resolvePost = resolve)),
    );
    renderChat(<Chat sessionId="session-1" />);

    fireEvent.click(screen.getByTestId("send-text-button"));
    await screen.findByTestId("user-row");

    await act(async () => {
      resolvePost({ ok: false, status: 500, message: "boom" });
    });

    await waitFor(() => expect(screen.queryByTestId("user-row")).toBeNull());
  });

  it("keeps backing off when resumed streams keep closing right away", async () => {
    const defaultOpen = rs.mocked(openTurnStream).getMockImplementation();
    rs.mocked(listSessionTurns)
      .mockResolvedValueOnce([{ turnId: "turn-1", status: "running" }])
      .mockResolvedValue([]);
    // HTTP 200 that ends at EOF without a terminal event, every time.
    rs.mocked(openTurnStream).mockImplementation(() =>
      Promise.resolve(new Response(new ReadableStream({ start: (c) => c.close() }))),
    );
    try {
      renderChat(<Chat sessionId="session-1" />);
      await waitFor(() => expect(openTurnStream).toHaveBeenCalledTimes(1));
      // Retries at +1 s and +3 s (1 s, then 2 s), not every second.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_500));
      });
      expect(openTurnStream).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("true");
    } finally {
      rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
      rs.mocked(openTurnStream).mockReset().mockImplementation(defaultOpen!);
    }
  });

  it.each([
    ["while the stream hangs", false],
    ["during the retry backoff after a drop", true],
  ])("follows a turn sent right after Stop releases a dead stream %s", async (_label, drop) => {
    const dropping: ReadableStreamDefaultController<Uint8Array>[] = [];
    const defaultOpen = rs.mocked(openTurnStream).getMockImplementation();
    if (drop) {
      rs.mocked(openTurnStream).mockImplementationOnce(() =>
        Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ start: (c) => void dropping.push(c) })),
        ),
      );
    }
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
      if (drop) {
        await act(async () => {
          dropping[0]!.error(new TypeError("network connection was lost"));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
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
      rs.mocked(openTurnStream).mockReset().mockImplementation(defaultOpen!);
    }
  });

  it("hides a backend turn's saved trace behind its live row once the stream names the turn", async () => {
    // A defer wake-up streams under a synthetic `backend:` key but saves its
    // trace under the agent's own turn id.
    const encoder = new TextEncoder();
    const defaultOpen = rs.mocked(openTurnStream).getMockImplementation();
    const traceMessage = (id: string, turnId: string) => ({
      id,
      sessionId: "session-1",
      turnId,
      role: "trace" as const,
      content: "[]",
      createdAt: "2026-10-22T00:00:00.000Z",
      traceSummary: { distinctApps: [], totalSteps: 1, invocationCounts: {} },
    });
    rs.mocked(listSessionMessages).mockResolvedValue([
      traceMessage("trace-old", "turn-old"),
      traceMessage("trace-real", "turn-real"),
    ]);
    rs.mocked(listSessionTurns).mockResolvedValue([
      { turnId: "backend:wake", streamId: "stream-wake", startedAt: "", status: "running" },
    ]);
    rs.mocked(openTurnStream).mockImplementation((_turnId, signal) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: turn_id\ndata: {"turnId":"turn-real"}\n\n'));
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return Promise.resolve(new Response(body));
    });
    try {
      renderChat(<Chat sessionId="session-1" />);
      await waitFor(() =>
        expect(openTurnStream).toHaveBeenCalledWith("backend:wake", expect.any(Object)),
      );
      // The earlier reply-less turn still stands alone. The running turn's
      // saved trace is carried by the live row only.
      await waitFor(() =>
        expect(screen.getAllByTestId("trace-row").map((row) => row.dataset.rowKey)).toEqual([
          "trace-old",
        ]),
      );
      expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("true");

      // Stop still names the `turnId` the stream was opened under, which the
      // listing keeps reporting, so the accepted interrupt does not
      // force-release the running turn.
      rs.mocked(interruptTurn).mockResolvedValue(new Response(null, { status: 202 }));
      rs.useFakeTimers();
      fireEvent.click(screen.getByTestId("stop-button"));
      await act(async () => {
        await rs.advanceTimersByTimeAsync(2_500);
      });
      expect(interruptTurn).toHaveBeenCalledWith("backend:wake");
      expect(rs.mocked(openTurnStream).mock.calls[0]?.[1]?.aborted).toBe(false);
      expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("true");
    } finally {
      rs.mocked(listSessionMessages).mockResolvedValue([]);
      rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
      rs.mocked(openTurnStream).mockReset().mockImplementation(defaultOpen!);
    }
  });

  it("hides a backend turn's saved trace on reattach when the listing names the turn", async () => {
    // A reload mid-turn finds the turn in the listing, which already carries the
    // agent's turn id. The stream sends nothing here, so only the listing can
    // name the turn.
    const defaultOpen = rs.mocked(openTurnStream).getMockImplementation();
    const traceMessage = (id: string, turnId: string) => ({
      id,
      sessionId: "session-1",
      turnId,
      role: "trace" as const,
      content: "[]",
      createdAt: "2026-10-22T00:00:00.000Z",
      traceSummary: { distinctApps: [], totalSteps: 1, invocationCounts: {} },
    });
    rs.mocked(listSessionMessages).mockResolvedValue([
      traceMessage("trace-old", "turn-old"),
      traceMessage("trace-real", "turn-real"),
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
    rs.mocked(openTurnStream).mockImplementation((_turnId, signal) => {
      const body = new ReadableStream<Uint8Array>({
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
    try {
      renderChat(<Chat sessionId="session-1" />);
      await waitFor(() =>
        expect(openTurnStream).toHaveBeenCalledWith("backend:wake", expect.any(Object)),
      );
      await waitFor(() =>
        expect(screen.getAllByTestId("trace-row").map((row) => row.dataset.rowKey)).toEqual([
          "trace-old",
        ]),
      );
      expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("true");
    } finally {
      rs.mocked(listSessionMessages).mockResolvedValue([]);
      rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
      rs.mocked(openTurnStream).mockReset().mockImplementation(defaultOpen!);
    }
  });

  it.each([
    ["done", '{"success":false,"error":"turn boom"}'],
    ["stream_error", '{"error":"turn boom"}'],
  ])("shows the turn's own %s failure on the composer", async (event, data) => {
    const encoder = new TextEncoder();
    const defaultOpen = rs.mocked(openTurnStream).getMockImplementation();
    rs.mocked(listSessionTurns)
      .mockResolvedValueOnce([{ turnId: "turn-1", status: "running" }])
      .mockResolvedValue([]);
    rs.mocked(openTurnStream).mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
              c.close();
            },
          }),
        ),
      ),
    );
    try {
      renderChat(<Chat sessionId="session-1" />);
      await waitFor(() => expect(screen.getByTestId("stream-error").textContent).toBe("turn boom"));
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
  it.each([
    "default",
    "concierge",
  ] as const)("releases a stale streaming entry when interrupt reports the turn is gone (%s)", async (variant) => {
    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    renderChat(<Chat sessionId="session-1" variant={variant} />);

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

  it.each([
    "default",
    "concierge",
  ] as const)("keeps Stop available while the server still reports the turn running (%s)", async (variant) => {
    rs.mocked(interruptTurn).mockResolvedValue(new Response(null, { status: 202 }));
    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
    renderChat(<Chat sessionId="session-1" variant={variant} />);
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

  it.each([
    "default",
    "concierge",
  ] as const)("does not let a delayed force-release abort a fresh stream for the same turn (%s)", async (variant) => {
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
    renderChat(<Chat sessionId="session-1" variant={variant} />);

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

describe("Chat while a turn streams text", () => {
  it("renders neither the chat nor its composer for each delivery of text", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    rs.mocked(openTurnStream).mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
          }),
        ),
      ),
    );
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("chat-composer").getAttribute("data-streaming")).toBe("true"),
    );
    const deliver = (text: string, blockIx = 0) =>
      act(async () => {
        controller.enqueue(
          encoder.encode(`event: assistant_text\ndata: ${JSON.stringify({ blockIx, text })}\n\n`),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    // The first delivery of a block is the one the chat may draw for.
    await deliver("first");
    renders.chat = 0;
    renders.composer = 0;

    let text = "first";
    for (let i = 0; i < 100; i++) {
      text += " word";
      await deliver(text);
    }

    expect(renders.chat).toBeLessThanOrEqual(2);
    expect(renders.composer).toBe(0);
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

describe("Chat draft", () => {
  it("creates its session on the first send and follows that turn without a reattach", async () => {
    rs.mocked(createSession).mockResolvedValueOnce({ id: "created-1" } as Awaited<
      ReturnType<typeof createSession>
    >);
    rs.mocked(postSessionTurn).mockResolvedValueOnce({ ok: true, data: { turnId: "turn-1" } });
    const onSessionCreated = rs.fn();
    renderChat(<Chat emptyState={<p>Empty home</p>} onSessionCreated={onSessionCreated} />);
    expect(screen.getByText("Empty home")).toBeTruthy();
    expect(screen.queryByTestId("message-list")).toBeNull();
    expect(screen.queryByRole("button", { name: "navbar.more" })).toBeNull();
    const composer = screen.getByTestId("chat-composer");

    fireEvent.click(screen.getByTestId("send-button"));

    await waitFor(() => expect(openTurnStream).toHaveBeenCalledTimes(1));
    expect(onSessionCreated).toHaveBeenCalledWith("created-1");
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: "sidebar.newChat", reasoningEffort: "medium" }),
    );
    expect(postSessionTurn).toHaveBeenCalledWith(
      "created-1",
      expect.any(FormData),
      expect.anything(),
    );
    expect(screen.queryByText("Empty home")).toBeNull();
    expect(screen.getByTestId("message-list")).toBeTruthy();
    expect(screen.getByTestId("chat-composer")).toBe(composer);
    // The send registered its local follow before the render that adopted the
    // session, so the reattach poll never looks the turn up.
    expect(listSessionTurns).not.toHaveBeenCalled();
  });
});

describe("Chat Concierge empty state", () => {
  const guidance = () => screen.queryByRole("region", { name: "concierge.empty.title" });
  // The file's default listing reports a running turn, which would reattach
  // and stream; these chats start idle.
  beforeEach(() => {
    rs.mocked(listSessionTurns).mockResolvedValue([]);
  });
  afterEach(() => {
    rs.mocked(listSessionTurns).mockResolvedValue([{ turnId: "turn-1", status: "running" }]);
  });

  it("guides a chat with no messages, and an example fills the composer", async () => {
    renderChat(<Chat sessionId="concierge" variant="concierge" />);

    expect(await screen.findByRole("region", { name: "concierge.empty.title" })).toBeTruthy();
    expect(screen.queryByTestId("message-list")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "concierge.empty.prompts.email" }));
    expect(conciergeInsertText).toHaveBeenCalledWith("concierge.empty.prompts.email");
  });

  it("waits for the history, so a chat with messages never shows it", async () => {
    let resolveMessages!: (messages: Awaited<ReturnType<typeof listSessionMessages>>) => void;
    rs.mocked(listSessionMessages).mockImplementationOnce(
      () => new Promise((resolve) => (resolveMessages = resolve)),
    );
    renderChat(<Chat sessionId="concierge" variant="concierge" />);
    expect(guidance()).toBeNull();

    await act(async () => {
      resolveMessages([
        {
          id: "m-1",
          sessionId: "concierge",
          role: "user" as const,
          content: "hello",
          createdAt: "2026-10-26T00:00:00.000Z",
        },
      ]);
    });
    expect(await screen.findByTestId("user-row")).toBeTruthy();
    expect(guidance()).toBeNull();
  });

  it("goes away as soon as the first message is sent", async () => {
    rs.mocked(postSessionTurn).mockImplementationOnce(() => new Promise(() => {}));
    renderChat(<Chat sessionId="concierge" variant="concierge" />);
    await screen.findByRole("region", { name: "concierge.empty.title" });

    fireEvent.click(screen.getByTestId("concierge-send-button"));

    expect(await screen.findByTestId("user-row")).toBeTruthy();
    expect(guidance()).toBeNull();
  });

  it("gives the phone shell its bar back while the tool pane covers a Concierge chat", async () => {
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Concierge",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    const seen: { outlet: boolean } = { outlet: false };
    function ShellProbe() {
      seen.outlet = useSlotOutlet(CONCIERGE_LEADING_SLOT);
      return null;
    }
    const tasksHost = (compact: boolean): ToolTasksHost => ({
      active: false,
      compact,
      show: rs.fn(),
      hide: rs.fn(),
    });
    const at = (compact: boolean, paneOpen: boolean) => (
      <SlotProvider>
        <ShellProbe />
        <ToolTasksContext.Provider value={tasksHost(compact)}>
          <ToolTraceContext.Provider
            value={{
              outlet: null,
              paneOpen,
              setPaneCollapsed: rs.fn(),
              reveal: rs.fn(),
              set: rs.fn(),
            }}
          >
            <Chat sessionId="concierge" variant="concierge" />
          </ToolTraceContext.Provider>
        </ToolTasksContext.Provider>
      </SlotProvider>
    );
    const view = render(<MemoryRouter>{at(true, false)}</MemoryRouter>, { wrapper: withQueries() });
    // Chat on screen: its floating header takes the shell's buttons.
    await waitFor(() => expect(seen.outlet).toBe(true));

    // The pane fills a narrow screen in place of the chat: the shell's bar is the way back.
    view.rerender(<MemoryRouter>{at(true, true)}</MemoryRouter>);
    await waitFor(() => expect(seen.outlet).toBe(false));

    // Beside the chat on a wide screen, the pane hides nothing.
    view.rerender(<MemoryRouter>{at(false, true)}</MemoryRouter>);
    await waitFor(() => expect(seen.outlet).toBe(true));
  });

  it("leaves the mascot's badge out while the chat has no messages, which draws its own", async () => {
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Concierge",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(<Chat sessionId="concierge" variant="concierge" />);
    await screen.findByRole("region", { name: "concierge.empty.title" });
    const header = document.querySelector<HTMLElement>("[data-concierge-header]")!;
    expect(header.querySelector("[data-concierge-header-badge]")).toBeNull();
    // The name tag takes the badge's row, and the buttons centre on it.
    const name = header.querySelector<HTMLElement>("[data-concierge-header-name]")!;
    expect(name.className).toContain("row-start-1");
    expect(within(name).getByText("Rome")).toBeTruthy();
    expect(within(header).getByRole("button", { name: "navbar.more" })).toBeTruthy();
  });

  it("floats the Concierge's header over its messages: the mascot's badge, a name tag, a status capsule and round buttons", async () => {
    mockConciergeActivity.mockReturnValue({ kind: "tasks", title: "Book the flight", more: 0 });
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Concierge",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    rs.mocked(listSessionMessages).mockResolvedValueOnce([
      {
        id: "m-1",
        sessionId: "concierge",
        role: "user" as const,
        content: "hello",
        createdAt: "2026-10-26T00:00:00.000Z",
      },
    ]);
    const view = renderChat(<Chat sessionId="concierge" variant="concierge" />);
    await screen.findByTestId("user-row");
    const header = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-concierge-header]");
      if (!found) throw new Error("no header");
      return found;
    });
    // No bar: it sits over the messages, which start below it.
    expect(header.className).toContain("absolute");
    expect(header.className).not.toMatch(/\bbg-|\bborder-b\b/);
    const scroller = header.parentElement!.querySelector<HTMLElement>(".overflow-y-auto")!;
    expect(scroller.className).toContain("concierge-header-clear");
    const badge = header.querySelector<HTMLElement>("[data-concierge-header-badge]")!;
    expect(badge.querySelector(".rome-mascot")).not.toBeNull();
    expect(badge.className).toContain("rounded-full");
    expect(
      within(header.querySelector<HTMLElement>("[data-concierge-header-name]")!).getByText("Rome"),
    ).toBeTruthy();
    expect(
      within(header.querySelector<HTMLElement>("[data-concierge-header-activity]")!).getByText(
        "concierge.activity.tasks",
      ),
    ).toBeTruthy();
    expect(
      header.querySelector("[data-concierge-header-status]")!.getAttribute("data-activity"),
    ).toBe("tasks");
    const more = within(header).getByRole("button", { name: "navbar.more" });
    expect(more.className).toContain("rounded-full");
    // The buttons share the badge's row, so they centre on the mascot.
    expect(badge.className).toContain("row-start-1");
    expect(more.closest<HTMLElement>(".col-start-3")!.className).toContain("row-start-1");
    expect(document.querySelector("[data-concierge-tasks-pill]")).toBeNull();
    view.unmount();

    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Plan the launch",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(<Chat sessionId="session-1" />);
    expect(await screen.findByText("Plan the launch")).toBeTruthy();
    expect(document.querySelector("[data-concierge-header]")).toBeNull();
    expect(screen.getByRole("button", { name: "navbar.more" }).className).not.toContain(
      "rounded-full",
    );
  });

  it("hangs the Concierge's mascot from the Mac app's title bar and puts its buttons in the bar", async () => {
    mockConciergeActivity.mockReturnValue({ kind: "tasks", title: "Book the flight", more: 0 });
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Concierge",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    const tasksHost = (compact: boolean): ToolTasksHost => ({
      active: false,
      compact,
      show: rs.fn(),
      hide: rs.fn(),
    });
    const at = (compact: boolean, paneOpen: boolean) => (
      <MemoryRouter>
        <SlotProvider>
          <div data-testid="bar">
            <SlotOutlet name="titlebar" />
          </div>
          <div data-testid="hang">
            <SlotOutlet name={CONCIERGE_TITLEBAR_SLOT} />
          </div>
          <ToolTasksContext.Provider value={tasksHost(compact)}>
            <ToolTraceContext.Provider
              value={{
                outlet: null,
                paneOpen,
                setPaneCollapsed: rs.fn(),
                reveal: rs.fn(),
                set: rs.fn(),
              }}
            >
              <Chat sessionId="concierge" variant="concierge" navbarSlot="titlebar" />
            </ToolTraceContext.Provider>
          </ToolTasksContext.Provider>
        </SlotProvider>
      </MemoryRouter>
    );
    const view = render(at(false, false), { wrapper: withQueries() });
    const hang = screen.getByTestId("hang");
    const bar = screen.getByTestId("bar");
    // The same badge, name tag and status as the floating header.
    const badge = await waitFor(() => {
      const found = hang.querySelector<HTMLElement>("[data-concierge-header-badge]");
      if (!found) throw new Error("no badge");
      return found;
    });
    expect(badge.querySelector(".rome-mascot")).not.toBeNull();
    expect(
      within(hang.querySelector<HTMLElement>("[data-concierge-header-name]")!).getByText("Rome"),
    ).toBeTruthy();
    expect(
      within(hang.querySelector<HTMLElement>("[data-concierge-header-activity]")!).getByText(
        "concierge.activity.tasks",
      ),
    ).toBeTruthy();
    expect(document.querySelector("[data-concierge-header]")).toBeNull();
    // The buttons are any chat's, in the bar.
    const more = within(bar).getByRole("button", { name: "navbar.more" });
    expect(more.className).not.toContain("rounded-full");
    expect(within(bar).getByRole("button", { name: "chat.expandTools" })).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".concierge-header-clear")!.className).toContain(
      "overflow-y-auto",
    );

    // The pane fills a narrow window in place of the chat: no mascot over it.
    view.rerender(at(true, true));
    await waitFor(() => expect(hang.querySelector("[data-concierge-header-badge]")).toBeNull());
    expect(within(bar).getByRole("button", { name: "navbar.more" })).toBeTruthy();
  });

  it("says what the Concierge is doing under its name", async () => {
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Concierge",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    mockConciergeActivity.mockReturnValue({ kind: "tool", tool: "startingTask" });
    const view = renderChat(<Chat sessionId="concierge" variant="concierge" />);
    expect(await screen.findByText("concierge.activity.tool.startingTask")).toBeTruthy();
    view.unmount();

    mockConciergeActivity.mockReturnValue({ kind: "needsYou" });
    const waiting = renderChat(<Chat sessionId="concierge" variant="concierge" />);
    expect((await screen.findByText("concierge.activity.needsYou")).className).toContain(
      "text-muted-foreground",
    );
    waiting.unmount();

    // Idle, the line is there for a screen reader only.
    mockConciergeActivity.mockReturnValue({ kind: "idle" });
    renderChat(<Chat sessionId="concierge" variant="concierge" />);
    expect(
      (await screen.findByText("concierge.activity.idle")).closest("[aria-live]")!.className,
    ).toContain("sr-only");
  });

  it("opens the task list from the agent's logo in a Concierge chat's header, not its menu", async () => {
    const user = userEvent.setup();
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Calendar",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(<Chat sessionId="topic-1" variant="concierge" conciergeMainChatId="concierge" />);
    // The header settles once the chat loads; press the button it settles on.
    await screen.findByRole("button", { name: "concierge.taskList.open" });
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "concierge.taskList.open" }));
      expect(mockOpenTaskList).toHaveBeenCalled();
    });
    await user.click(screen.getByRole("button", { name: "navbar.more" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).not.toContain(
      "concierge.tasks.title",
    );
  });

  it("offers Share chat but no Archive or Delete for the main chat, and all three for a topic chat", async () => {
    const user = userEvent.setup();
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Concierge",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    const main = renderChat(
      <Chat sessionId="concierge" variant="concierge" conciergeMainChatId="concierge" />,
    );
    await user.click(await screen.findByRole("button", { name: "navbar.more" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "share.title",
    ]);
    await user.keyboard("{Escape}");
    main.unmount();

    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Calendar",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(<Chat sessionId="topic-1" variant="concierge" conciergeMainChatId="concierge" />);
    await user.click(await screen.findByRole("button", { name: "navbar.more" }));
    expect(screen.getByRole("menuitem", { name: "navbar.archive" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "navbar.delete" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "share.title" })).toBeTruthy();
  });

  it("offers Share chat in a common chat too", async () => {
    const user = userEvent.setup();
    renderChat(<Chat sessionId="session-1" />);
    await user.click(await screen.findByRole("button", { name: "navbar.more" }));
    expect(screen.getByRole("menuitem", { name: "share.title" })).toBeTruthy();
  });

  const twoTurns = () =>
    rs.mocked(listSessionMessages).mockResolvedValueOnce(
      [
        ["u-1", "turn-a", "First"],
        ["u-2", "turn-b", "Second"],
      ].map(([id, turnId, text]) => ({
        id: id!,
        sessionId: "session-1",
        turnId: turnId!,
        role: "user",
        content: JSON.stringify([{ type: "text", content: text }]),
        createdAt: "2026-11-10T10:00:00Z",
      })),
    );
  const shareFrom = async (text: string) => {
    const row = (await screen.findAllByTestId("user-row")).find((r) =>
      r.textContent?.includes(text),
    );
    await userEvent.click(within(row!).getByRole("button", { name: "message.share" }));
  };

  it("opens share mode from a message's Share, with only that message's turn selected", async () => {
    twoTurns();
    renderChat(<Chat sessionId="session-1" />);
    await screen.findAllByTestId("user-row");
    expect(screen.queryByTestId("share-bar")).toBeNull();
    await shareFrom("Second");
    expect((await screen.findByTestId("share-bar")).textContent).toBe("turn-b");
  });

  it("picks every turn for Share chat in a common chat, and none in a Concierge chat", async () => {
    const user = userEvent.setup();
    twoTurns();
    const common = renderChat(<Chat sessionId="session-1" />);
    await screen.findAllByTestId("user-row");
    await user.click(screen.getByRole("button", { name: "navbar.more" }));
    await user.click(screen.getByRole("menuitem", { name: "share.title" }));
    expect((await screen.findByTestId("share-bar")).textContent).toBe("turn-a,turn-b");
    common.unmount();

    twoTurns();
    renderChat(<Chat sessionId="session-1" variant="concierge" conciergeMainChatId="session-1" />);
    await screen.findAllByTestId("user-row");
    await user.click(await screen.findByRole("button", { name: "navbar.more" }));
    await user.click(screen.getByRole("menuitem", { name: "share.title" }));
    expect((await screen.findByTestId("share-bar")).textContent).toBe("");
  });

  it("picks an older thread message's own turn, which the timeline has not loaded", async () => {
    twoTurns();
    renderChat(<Chat sessionId="session-1" />);
    await screen.findAllByTestId("user-row");
    fireEvent.click(
      within(screen.getByTestId("older-thread-message")).getByRole("button", {
        name: "message.share",
      }),
    );
    expect((await screen.findByTestId("share-bar")).textContent).toBe("turn-old");
  });

  it("refuses a file dropped in share mode, and takes one again after it", async () => {
    const user = userEvent.setup();
    twoTurns();
    renderChat(<Chat sessionId="session-1" variant="concierge" conciergeMainChatId="session-1" />);
    await screen.findAllByTestId("user-row");
    const drop = () => {
      const file = new File(["x"], "plan.txt", { type: "text/plain" });
      fireEvent.drop(screen.getByTestId("message-list").closest(".\\@container\\/chat")!, {
        dataTransfer: { types: ["Files"], files: [file], items: [] },
      });
    };
    await user.click(await screen.findByRole("button", { name: "navbar.more" }));
    await user.click(screen.getByRole("menuitem", { name: "share.title" }));
    await screen.findByTestId("share-bar");
    drop();
    expect(conciergeAddFiles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("share-exit"));
    await waitFor(() => expect(screen.queryByTestId("share-bar")).toBeNull());
    drop();
    expect(conciergeAddFiles).toHaveBeenCalledOnce();
  });

  it("keeps the composer, and its draft, through share mode", async () => {
    twoTurns();
    renderChat(<Chat sessionId="session-1" />);
    await screen.findAllByTestId("user-row");
    const composer = screen.getByTestId("chat-composer");
    await shareFrom("Second");
    await screen.findByTestId("share-bar");
    // Hidden, not unmounted: the same composer, with whatever it holds.
    expect(composer.isConnected).toBe(true);
    expect(composer.parentElement?.className).toContain("hidden");
    fireEvent.click(screen.getByTestId("share-exit"));
    await waitFor(() => expect(screen.queryByTestId("share-bar")).toBeNull());
    expect(screen.getByTestId("chat-composer")).toBe(composer);
    expect(composer.parentElement?.className).not.toContain("hidden");
  });

  it("labels a Concierge share's agent by the name its header shows", async () => {
    twoTurns();
    renderChat(
      <Chat
        sessionId="session-1"
        variant="concierge"
        conciergeMainChatId="session-1"
        conciergeName="Flint"
      />,
    );
    await shareFrom("Second");
    expect((await screen.findByTestId("share-bar")).dataset.agentName).toBe("Flint");
  });

  it("closes the thread view before a message's Share opens share mode behind it", async () => {
    twoTurns();
    // The thread view reads its messages through a query.
    renderChat(
      <QueryClientProvider client={new QueryClient()}>
        <Chat sessionId="session-1" variant="concierge" conciergeMainChatId="session-1" />
      </QueryClientProvider>,
    );
    await screen.findAllByTestId("user-row");
    fireEvent.click(screen.getByTestId("open-thread"));
    expect(await screen.findByRole("button", { name: "thread.close" })).toBeTruthy();
    await shareFrom("Second");
    expect((await screen.findByTestId("share-bar")).textContent).toBe("turn-b");
    expect(screen.queryByRole("button", { name: "thread.close" })).toBeNull();
  });

  it("heads the main chat and a topic chat alike, with the agent's chosen name", async () => {
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Concierge",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    const main = renderChat(
      <Chat sessionId="concierge" variant="concierge" conciergeName="Milo" />,
    );
    expect(await screen.findByText("Milo")).toBeTruthy();
    expect(screen.queryByText("Concierge")).toBeNull();
    main.unmount();

    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Calendar",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    renderChat(
      <Chat
        sessionId="topic-1"
        variant="concierge"
        conciergeMainChatId="concierge"
        conciergeName="Milo"
      />,
    );
    expect(await screen.findByText("Milo")).toBeTruthy();
    // The header still goes by the Concierge's name, not the topic's.
    expect(screen.queryByText("Calendar")).toBeNull();
  });

  it("names an open topic chat in its message box, which follows a rename, and not the main chat", async () => {
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Main chat",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    const main = renderChat(
      <Chat sessionId="concierge" variant="concierge" conciergeMainChatId="concierge" />,
    );
    expect((await screen.findByTestId("chat-composer")).getAttribute("data-chat-name")).toBe("");
    main.unmount();

    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Trip to Lisbon",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    const view = renderChat(
      <Chat sessionId="topic-1" variant="concierge" conciergeMainChatId="concierge" />,
    );
    expect((await screen.findByTestId("chat-composer")).getAttribute("data-chat-name")).toBe(
      "Trip to Lisbon",
    );

    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Lisbon flights",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    view.rerender(
      <MemoryRouter>
        {pane(<Chat sessionId="topic-1" variant="concierge" conciergeMainChatId="concierge" />)}
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-composer").getAttribute("data-chat-name")).toBe(
        "Lisbon flights",
      ),
    );

    // A topic chat with no name yet keeps the plain box.
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "  ",
      pinnedAgentMention: null,
      archivedAt: null,
    });
    view.rerender(
      <MemoryRouter>
        {pane(<Chat sessionId="topic-1" variant="concierge" conciergeMainChatId="concierge" />)}
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-composer").getAttribute("data-chat-name")).toBe(""),
    );
  });

  it("names the agent's app beside a titled chat, but not beside the Concierge's name", async () => {
    // Core agents all report "Rome" as their app, so the Concierge's label never varies.
    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Concierge",
      pinnedAgentMention: {
        appId: "core",
        appLabel: "Rome",
        agentName: "core:concierge",
        iconUrl: null,
      },
      archivedAt: null,
    });
    const view = renderChat(
      <Chat sessionId="concierge" variant="concierge" conciergeName="Flint" />,
    );
    await screen.findByText("Flint");
    expect(screen.queryByText("Rome")).toBeNull();
    view.unmount();

    mockUseSessionIdentity.mockReturnValue({
      sessionName: "Plan the launch",
      pinnedAgentMention: {
        appId: "workflow-studio",
        appLabel: "Workflow Studio",
        agentName: "workflow-planner",
        iconUrl: null,
      },
      archivedAt: null,
    });
    renderChat(<Chat sessionId="session-1" />);
    expect(await screen.findByText("Workflow Studio")).toBeTruthy();
  });

  it("is only for Concierge: an empty normal chat keeps its message list", async () => {
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalled());
    expect(screen.getByTestId("message-list")).toBeTruthy();
    expect(guidance()).toBeNull();
  });
});

describe("Chat Concierge jump to a message", () => {
  const message = (n: number) => ({
    id: `m-${n}`,
    sessionId: "concierge",
    turnId: `turn-${n}`,
    role: "user" as const,
    content: `question ${n}`,
    createdAt: new Date(Date.UTC(2026, 9, 27, 12, 0, n)).toISOString(),
  });
  const anchor = (id: string) => document.querySelector(`[data-timeline-anchor="${id}"]`);
  const rows = () => screen.queryAllByTestId("user-row").length;
  const originalScrollTo = Element.prototype.scrollTo;
  const scrollTo = rs.fn();

  beforeEach(() => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    Element.prototype.scrollTo = scrollTo as typeof Element.prototype.scrollTo;
    scrollTo.mockClear();
    toast.loading.mockClear();
    toast.error.mockClear();
    toast.dismiss.mockClear();
  });
  afterEach(() => {
    Element.prototype.scrollTo = originalScrollTo;
  });

  it("scrolls to a message that is on screen and tints it, with no waiting", async () => {
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce({
      messages: [message(1), message(2)],
      nextCursor: null,
    });
    renderChat(<Chat sessionId="concierge" variant="concierge" />);
    await waitFor(() => expect(rows()).toBe(2));

    act(() => void requestConciergeJump("m-2"));

    expect(scrollTo).toHaveBeenCalledOnce();
    expect(anchor("m-2")?.hasAttribute("data-timeline-landed")).toBe(true);
    expect(toast.loading).not.toHaveBeenCalled();
    expect(listSessionMessagePage).toHaveBeenCalledTimes(1);
  });

  it("lands a jumped-to message below the floating header, not under it", async () => {
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce({
      messages: [message(1), message(2)],
      nextCursor: null,
    });
    renderChat(<Chat sessionId="concierge" variant="concierge" />);
    await waitFor(() => expect(rows()).toBe(2));
    const scroller = document.querySelector<HTMLElement>(".concierge-header-clear")!;
    // jsdom applies no stylesheet: stand in for the header's scroll padding.
    scroller.style.scrollPaddingTop = "112px";
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    Object.defineProperty(scroller, "scrollTop", { value: 1000, configurable: true });
    anchor("m-2")!.getBoundingClientRect = () => ({ top: 500 }) as DOMRect;

    act(() => void requestConciergeJump("m-2"));

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000 + 500 - 112 - 24, behavior: "auto" });
  });

  it("reads from the oldest loaded turn through the message in one page, says so meanwhile, then jumps", async () => {
    rs.mocked(listSessionMessagePage)
      .mockResolvedValueOnce({ messages: [message(5), message(6)], nextCursor: "c1" })
      .mockResolvedValueOnce({
        messages: [message(1), message(2), message(3), message(4)],
        nextCursor: null,
      });
    renderChat(<Chat sessionId="concierge" variant="concierge" />);
    await waitFor(() => expect(rows()).toBe(2));

    act(() => void requestConciergeJump("m-1"));

    await waitFor(() => expect(anchor("m-1")?.hasAttribute("data-timeline-landed")).toBe(true));
    expect(toast.loading).toHaveBeenCalledWith("concierge.tasks.findingMessage");
    expect(toast.dismiss).toHaveBeenCalledWith("finding");
    expect(toast.error).not.toHaveBeenCalled();
    expect(rs.mocked(listSessionMessagePage).mock.calls.map((call) => call[1])).toEqual([
      { limit: expect.any(Number) },
      { limit: expect.any(Number), before: "c1", through: "m-1" },
    ]);
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("holds a pinned view still while it scrolls, so the jump is not read as drift", async () => {
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce({
      messages: [message(1), message(2)],
      nextCursor: null,
    });
    renderChat(<Chat sessionId="concierge" variant="concierge" />);
    await waitFor(() => expect(rows()).toBe(2));
    const order: string[] = [];
    anchor("m-1")!.addEventListener(HOLD_STICK_EVENT, () => order.push("hold"));
    scrollTo.mockImplementation(() => order.push("scroll"));

    act(() => void requestConciergeJump("m-1"));

    expect(order).toEqual(["hold", "scroll"]);
  });

  it("says it can't find a message the one read does not bring", async () => {
    rs.mocked(listSessionMessagePage)
      .mockResolvedValueOnce({ messages: [message(9)], nextCursor: "c1" })
      .mockResolvedValueOnce({ messages: [message(8)], nextCursor: "c2" });
    renderChat(<Chat sessionId="concierge" variant="concierge" />);
    await waitFor(() => expect(rows()).toBe(1));

    act(() => void requestConciergeJump("m-missing"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("concierge.tasks.sourceMissing"));
    // The newest page, then one read through the message.
    expect(listSessionMessagePage).toHaveBeenCalledTimes(2);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalledWith("finding");
  });

  it("says it can't find a message when all the history is loaded and it is not there", async () => {
    rs.mocked(listSessionMessagePage)
      .mockResolvedValueOnce({ messages: [message(3), message(4)], nextCursor: "c1" })
      .mockResolvedValueOnce({ messages: [message(1), message(2)], nextCursor: null });
    renderChat(<Chat sessionId="concierge" variant="concierge" />);
    await waitFor(() => expect(rows()).toBe(2));

    act(() => void requestConciergeJump("m-gone"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("concierge.tasks.sourceMissing"));
    expect(listSessionMessagePage).toHaveBeenCalledTimes(2);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("is for the Concierge chat only", async () => {
    rs.mocked(listSessionMessagePage).mockResolvedValueOnce({
      messages: [{ ...message(2), sessionId: "session-1" }],
      nextCursor: "c1",
    });
    renderChat(<Chat sessionId="session-1" />);
    await waitFor(() => expect(rows()).toBe(1));

    act(() => void requestConciergeJump("m-2"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(scrollTo).not.toHaveBeenCalled();
    expect(listSessionMessagePage).toHaveBeenCalledTimes(1);
  });
});
