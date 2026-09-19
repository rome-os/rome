// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as chatApiModule from "@/lib/chat-api" with { rstest: "importActual" };
import { Chat } from "./Chat";
import { ChatComposer as ActualChatComposer } from "./ChatComposer" with { rstest: "importActual" };
import type { ChatComposerSendControls, ChatComposerSnapshot } from "./ChatComposer";
import type { ChatRow } from "./chat-view";
import type { ChatMessage } from "@/lib/chat-types";
import { AUTH_QUERY_KEY } from "@/lib/auth-state";
import {
  AuthenticatedChatTranscriptCacheBoundary,
  ChatTranscriptCacheContext,
} from "@/lib/chat-transcript-cache-context";
import { chatTranscriptCache } from "@/lib/chat-transcript-cache";
import {
  ChatApiError,
  deleteSession,
  interruptTurn,
  listSessionMessages,
  listSessionTurns,
  openTurnStream,
  postSessionTurn,
} from "@/lib/chat-api";

const t = (key: string) => key;
const mockUseSessionIdentity = rs.hoisted(() => rs.fn());
const mockUseDashboardIdentity = rs.hoisted(() => rs.fn());
const mockInvalidateQueries = rs.hoisted(() => rs.fn());
const appsPanel = rs.hoisted(() => ({ collapsed: true, setCollapsed: rs.fn() }));
const composerHarness = rs.hoisted(() => ({
  useActual: false,
  onSend: null as
    | null
    | ((
        snapshot: ChatComposerSnapshot,
        controls: ChatComposerSendControls,
      ) => void | Promise<void>),
}));

rs.mock("react-i18next", () => ({
  useTranslation: () => ({ t }),
}));

rs.mock("@/components/chat/use-session-identity", () => ({
  useSessionIdentity: mockUseSessionIdentity,
}));

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: mockUseDashboardIdentity,
}));

rs.mock("@/lib/query-client", () => ({
  queryClient: { invalidateQueries: mockInvalidateQueries },
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
  MessageList: ({ live, rows }: { live: { identity: { name: string } }; rows: ChatRow[] }) => {
    const messageIds = rows.flatMap((row) =>
      row.kind === "agent" ? row.messages.map((message) => message.id) : [row.message.id],
    );
    return (
      <div data-testid="message-list" data-message-ids={messageIds.join(",")}>
        {live.identity.name}
      </div>
    );
  },
  findActiveSubmission: () => null,
  findLastSubmission: () => null,
  hasPendingApprovalConfirmation: () => false,
}));

rs.mock("@/components/chat/ChatComposer", () => ({
  // Expose the streaming state + Stop wiring so tests can drive stopMessage
  // the way the real composer's Stop button does.
  ChatComposer: (props: {
    isStreaming?: boolean;
    onStop?: () => void;
    onSend: (
      snapshot: ChatComposerSnapshot,
      controls: ChatComposerSendControls,
    ) => void | Promise<void>;
  }) => {
    composerHarness.onSend = props.onSend;
    if (composerHarness.useActual) return <ActualChatComposer {...props} />;
    return (
      <div data-testid="chat-composer" data-streaming={props.isStreaming ? "true" : "false"}>
        {props.isStreaming && props.onStop ? (
          <button type="button" data-testid="stop-button" onClick={props.onStop} />
        ) : null}
      </div>
    );
  },
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
  rs.mocked(deleteSession).mockResolvedValue(new Response(null, { status: 204 }));
  rs.mocked(listSessionMessages).mockResolvedValue([]);
  mockInvalidateQueries.mockResolvedValue(undefined);
  mockUseDashboardIdentity.mockReturnValue({
    data: {
      kind: "guardian",
      userId: "guardian-1",
      displayName: "Guardian",
      avatarUrl: null,
    },
  });
  mockUseSessionIdentity.mockReturnValue({
    sessionName: null,
    pinnedAgentMention: null,
    archivedAt: null,
  });
  composerHarness.onSend = null;
  composerHarness.useActual = false;
});

afterEach(() => {
  rs.useRealTimers();
  cleanup();
  rs.clearAllMocks();
  rs.unstubAllGlobals();
  MockEventSource.instances = [];
  chatTranscriptCache.clear();
});

function chatMessage(sessionId: string, id: string, createdAt: string): ChatMessage {
  return {
    id,
    sessionId,
    turnId: `turn-${id}`,
    role: "assistant",
    content: JSON.stringify([{ type: "text", content: id }]),
    createdAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("Chat history cache", () => {
  const context = "https://rome.test|guardian:guardian-1";
  beforeEach(() => {
    chatTranscriptCache.activateContext(context);
  });
  const renderCachedChat = (sessionId: string, props: { onSessionNotFound?: () => void } = {}) => (
    <MemoryRouter>
      <ChatTranscriptCacheContext.Provider value={context}>
        <Chat key={sessionId} sessionId={sessionId} onSessionNotFound={props.onSessionNotFound} />
      </ChatTranscriptCacheContext.Provider>
    </MemoryRouter>
  );
  const renderCachedChatWithRealComposer = (sessionId: string) => (
    <QueryClientProvider client={new QueryClient()}>
      {renderCachedChat(sessionId)}
    </QueryClientProvider>
  );

  it("renders a revisited transcript before its refresh resolves, then reconciles it", async () => {
    const aOld = chatMessage("session-a", "a-old", "2026-09-19T00:00:00.000Z");
    const aNew = chatMessage("session-a", "a-new", "2026-09-19T00:01:00.000Z");
    const b = chatMessage("session-b", "b", "2026-09-19T00:00:00.000Z");
    const refresh = deferred<ChatMessage[] | null>();
    let aLoads = 0;
    rs.mocked(listSessionMessages).mockImplementation((sessionId) => {
      if (sessionId === "session-b") return Promise.resolve([b]);
      aLoads += 1;
      return aLoads === 1 ? Promise.resolve([aOld]) : refresh.promise;
    });

    const view = render(renderCachedChat("session-a"));
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("a-old"),
    );

    view.rerender(renderCachedChat("session-b"));
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("b"),
    );

    view.rerender(renderCachedChat("session-a"));
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("a-old");
    expect(screen.queryByText("history.loading")).toBeNull();
    expect(screen.getByTestId("chat-composer")).toBeTruthy();

    refresh.resolve([aNew, aOld]);
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe(
        "a-old,a-new",
      ),
    );
  });

  it("renders cached history on the first child render after the authenticated boundary remounts", async () => {
    const boundaryContext = `${window.location.origin}|guardian:guardian-1`;
    const old = chatMessage("session-a", "old", "2026-09-19T00:00:00.000Z");
    const current = chatMessage("session-a", "current", "2026-09-19T00:01:00.000Z");
    chatTranscriptCache.activateContext(boundaryContext);

    const previousRoute = render(
      <AuthenticatedChatTranscriptCacheBoundary>
        <div>full app route</div>
      </AuthenticatedChatTranscriptCacheBoundary>,
    );
    previousRoute.unmount();
    chatTranscriptCache.putComplete(boundaryContext, "session-a", [old]);
    const refresh = deferred<ChatMessage[] | null>();
    rs.mocked(listSessionMessages).mockReturnValue(refresh.promise);

    render(
      <MemoryRouter>
        <AuthenticatedChatTranscriptCacheBoundary>
          <Chat sessionId="session-a" />
        </AuthenticatedChatTranscriptCacheBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("old");
    expect(screen.queryByText("history.loading")).toBeNull();
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());

    refresh.resolve([old, current]);
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe(
        "old,current",
      ),
    );
    expect(
      chatTranscriptCache.get(boundaryContext, "session-a")?.map((message) => message.id),
    ).toEqual(["old", "current"]);
  });

  it("activates the cache after identity resolves without restarting Chat", async () => {
    chatTranscriptCache.activateContext(null);
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const initialLoad = deferred<ChatMessage[] | null>();
    const loaded = chatMessage("session-a", "loaded", "2026-09-19T00:00:00.000Z");
    rs.mocked(listSessionMessages).mockReturnValue(initialLoad.promise);

    const view = render(
      <MemoryRouter>
        <ChatTranscriptCacheContext.Provider value={null}>
          <Chat sessionId="session-a" />
        </ChatTranscriptCacheContext.Provider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    chatTranscriptCache.activateContext(context);
    view.rerender(
      <MemoryRouter>
        <ChatTranscriptCacheContext.Provider value={context}>
          <Chat sessionId="session-a" />
        </ChatTranscriptCacheContext.Provider>
      </MemoryRouter>,
    );
    expect(listSessionMessages).toHaveBeenCalledOnce();
    expect(MockEventSource.instances).toHaveLength(1);

    initialLoad.resolve([loaded]);
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("loaded"),
    );
    expect(chatTranscriptCache.get(context, "session-a")?.map((message) => message.id)).toEqual([
      "loaded",
    ]);
  });

  it("promotes an already loaded history when identity becomes available", async () => {
    chatTranscriptCache.activateContext(null);
    const loaded = chatMessage("session-a", "loaded", "2026-09-19T00:00:00.000Z");
    rs.mocked(listSessionMessages).mockResolvedValue([loaded]);

    const view = render(
      <MemoryRouter>
        <ChatTranscriptCacheContext.Provider value={null}>
          <Chat sessionId="session-a" />
        </ChatTranscriptCacheContext.Provider>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("loaded"),
    );
    expect(chatTranscriptCache.snapshot().ids).toEqual([]);

    chatTranscriptCache.activateContext(context);
    view.rerender(
      <MemoryRouter>
        <ChatTranscriptCacheContext.Provider value={context}>
          <Chat sessionId="session-a" />
        </ChatTranscriptCacheContext.Provider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(chatTranscriptCache.get(context, "session-a")?.map((message) => message.id)).toEqual([
        "loaded",
      ]),
    );
    expect(listSessionMessages).toHaveBeenCalledOnce();
  });

  it("terminalizes both Chat instances when they load the same uncached session", async () => {
    const firstLoad = deferred<ChatMessage[] | null>();
    const secondLoad = deferred<ChatMessage[] | null>();
    const firstMessage = chatMessage("session-a", "first", "2026-09-19T00:00:00.000Z");
    const secondMessage = chatMessage("session-a", "second", "2026-09-19T00:01:00.000Z");
    rs.mocked(listSessionMessages)
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);

    render(
      <MemoryRouter>
        <ChatTranscriptCacheContext.Provider value={context}>
          <div data-testid="first-chat">
            <Chat sessionId="session-a" />
          </div>
          <div data-testid="second-chat">
            <Chat sessionId="session-a" />
          </div>
        </ChatTranscriptCacheContext.Provider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(2));

    secondLoad.resolve([secondMessage]);
    firstLoad.resolve([firstMessage]);
    await waitFor(() => {
      expect(
        within(screen.getByTestId("first-chat"))
          .getByTestId("message-list")
          .getAttribute("data-message-ids"),
      ).toBe("first");
      expect(
        within(screen.getByTestId("second-chat"))
          .getByTestId("message-list")
          .getAttribute("data-message-ids"),
      ).toBe("second");
    });
    expect(within(screen.getByTestId("first-chat")).queryByText("history.loading")).toBeNull();
    expect(within(screen.getByTestId("second-chat")).queryByText("history.loading")).toBeNull();
  });

  it("does not let a delayed response replace the newly selected transcript", async () => {
    const delayedA = deferred<ChatMessage[] | null>();
    const a = chatMessage("session-a", "a", "2026-09-19T00:00:00.000Z");
    const b = chatMessage("session-b", "b", "2026-09-19T00:00:00.000Z");
    rs.mocked(listSessionMessages).mockImplementation((sessionId) =>
      sessionId === "session-a" ? delayedA.promise : Promise.resolve([b]),
    );

    const view = render(renderCachedChat("session-a"));
    view.rerender(renderCachedChat("session-b"));
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("b"),
    );

    delayedA.resolve([a]);
    await act(async () => {
      await delayedA.promise;
    });
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("b");
    expect(chatTranscriptCache.get(context, "session-a")?.map((message) => message.id)).toEqual([
      "a",
    ]);
  });

  it("keeps cached history visible after a failed refresh and retries", async () => {
    const user = userEvent.setup();
    const old = chatMessage("session-a", "old", "2026-09-19T00:00:00.000Z");
    const current = chatMessage("session-a", "current", "2026-09-19T00:01:00.000Z");
    chatTranscriptCache.putComplete(context, "session-a", [old]);
    rs.mocked(listSessionMessages)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([old, current]);

    render(renderCachedChat("session-a"));

    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("old");
    expect(await screen.findByText("history.refreshFailed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "history.retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe(
        "old,current",
      ),
    );
    expect(screen.queryByText("history.refreshFailed")).toBeNull();
  });

  it.each([
    401, 403,
  ])("clears cached and visible history when refresh loses authorization with HTTP %s", async (status) => {
    const old = chatMessage("session-a", "old", "2026-09-19T00:00:00.000Z");
    chatTranscriptCache.putComplete(context, "session-a", [old]);
    rs.mocked(listSessionMessages).mockRejectedValue(
      new ChatApiError("authorization lost", status, null),
    );

    const view = render(renderCachedChat("session-a"));
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("old");

    expect(await screen.findByText("history.loadFailed")).toBeTruthy();
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("");
    expect(chatTranscriptCache.get(context, "session-a")).toBeUndefined();
    await waitFor(() =>
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: AUTH_QUERY_KEY }),
    );

    view.unmount();
    rs.mocked(listSessionMessages).mockReturnValue(new Promise(() => {}));
    render(renderCachedChat("session-a"));
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("");
  });

  it.each([
    401, 403,
  ])("fails closed when a superseded cached refresh returns HTTP %s", async (status) => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const old = chatMessage("session-a", "old", "2026-09-19T00:00:00.000Z");
    const initialLoad = deferred<ChatMessage[] | null>();
    const forcedRefresh = deferred<ChatMessage[] | null>();
    chatTranscriptCache.putComplete(context, "session-a", [old]);
    rs.mocked(listSessionMessages)
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(forcedRefresh.promise);

    render(renderCachedChat("session-a"));
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("old");
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    act(() => {
      const source = MockEventSource.instances[0]!;
      source.emitLifecycle("open", MockEventSource.OPEN);
      source.emitLifecycle("error", MockEventSource.CONNECTING);
      source.emitLifecycle("open", MockEventSource.OPEN);
    });
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(2));

    await act(async () => {
      initialLoad.reject(new ChatApiError("authorization lost", status, null));
      await initialLoad.promise.catch(() => undefined);
    });

    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe(""),
    );
    expect(chatTranscriptCache.get(context, "session-a")).toBeUndefined();
    await waitFor(() =>
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: AUTH_QUERY_KEY }),
    );

    await act(async () => {
      forcedRefresh.reject(new Error("offline"));
      await forcedRefresh.promise.catch(() => undefined);
    });
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("");
    expect(chatTranscriptCache.get(context, "session-a")).toBeUndefined();
  });

  it.each([
    401, 403,
  ])("purges every same-context session and rejects pre-purge work after HTTP %s", async (status) => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    mockInvalidateQueries.mockReturnValue(new Promise(() => {}));
    const oldA = chatMessage("session-a", "old-a", "2026-09-19T00:00:00.000Z");
    const oldB = chatMessage("session-b", "old-b", "2026-09-19T00:00:00.000Z");
    const staleInsertB = chatMessage("session-b", "stale-insert-b", "2026-09-19T00:01:00.000Z");
    const loadA = deferred<ChatMessage[] | null>();
    const loadB = deferred<ChatMessage[] | null>();
    let sessionBStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    chatTranscriptCache.putComplete(context, "session-a", [oldA]);
    chatTranscriptCache.putComplete(context, "session-b", [oldB]);
    rs.mocked(listSessionMessages).mockImplementation((sessionId) =>
      sessionId === "session-a" ? loadA.promise : loadB.promise,
    );
    rs.mocked(listSessionTurns)
      .mockResolvedValueOnce([{ turnId: "turn-session-a", status: "running" }])
      .mockResolvedValueOnce([{ turnId: "turn-session-b", status: "running" }]);
    rs.mocked(openTurnStream)
      .mockResolvedValueOnce(new Response(new ReadableStream()))
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                // Deliberately ignore abort for B so the test can deliver a
                // pre-revocation stream callback after the context purge.
                sessionBStream = controller;
              },
            }),
          ),
        ),
      );

    render(
      <MemoryRouter>
        <ChatTranscriptCacheContext.Provider value={context}>
          <div data-testid="chat-a">
            <Chat sessionId="session-a" />
          </div>
          <div data-testid="chat-b">
            <Chat sessionId="session-b" />
          </div>
        </ChatTranscriptCacheContext.Provider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
    expect(
      within(screen.getByTestId("chat-a"))
        .getByTestId("message-list")
        .getAttribute("data-message-ids"),
    ).toBe("old-a");
    expect(
      within(screen.getByTestId("chat-b"))
        .getByTestId("message-list")
        .getAttribute("data-message-ids"),
    ).toBe("old-b");
    await waitFor(() =>
      expect(
        within(screen.getByTestId("chat-b"))
          .getByTestId("chat-composer")
          .getAttribute("data-streaming"),
      ).toBe("true"),
    );
    const sessionBSource = MockEventSource.instances.find((source) =>
      source.url.toString().includes("session-b"),
    );
    const staleMessageListener = [...(sessionBSource?.listeners.get("message_insert") ?? [])][0]!;

    await act(async () => {
      loadA.reject(new ChatApiError("authorization lost", status, null));
      await loadA.promise.catch(() => undefined);
    });

    for (const testId of ["chat-a", "chat-b"]) {
      expect(
        within(screen.getByTestId(testId))
          .getByTestId("message-list")
          .getAttribute("data-message-ids"),
      ).toBe("");
    }
    expect(chatTranscriptCache.snapshot().ids).toEqual([]);
    expect(
      within(screen.getByTestId("chat-b"))
        .getByTestId("chat-composer")
        .getAttribute("data-streaming"),
    ).toBe("false");
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: AUTH_QUERY_KEY });
    expect(MockEventSource.instances).toHaveLength(2);

    act(() => {
      staleMessageListener(
        new MessageEvent("message_insert", { data: JSON.stringify(staleInsertB) }),
      );
      sessionBStream?.enqueue(new TextEncoder().encode('event: done\ndata: {"success":true}\n\n'));
    });
    loadB.resolve([oldB, staleInsertB]);
    await act(async () => {
      await loadB.promise;
    });

    for (const testId of ["chat-a", "chat-b"]) {
      expect(
        within(screen.getByTestId(testId))
          .getByTestId("message-list")
          .getAttribute("data-message-ids"),
      ).toBe("");
    }
    expect(chatTranscriptCache.snapshot().ids).toEqual([]);
    expect(listSessionMessages).toHaveBeenCalledTimes(2);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("rejects a send after authorization revocation so the real composer restores its draft", async () => {
    composerHarness.useActual = true;
    mockInvalidateQueries.mockReturnValue(new Promise(() => {}));
    const old = chatMessage("session-a", "old", "2026-09-19T00:00:00.000Z");
    const refresh = deferred<ChatMessage[] | null>();
    chatTranscriptCache.putComplete(context, "session-a", [old]);
    rs.mocked(listSessionMessages).mockReturnValue(refresh.promise);
    rs.mocked(listSessionTurns).mockResolvedValueOnce([]);

    render(renderCachedChatWithRealComposer("session-a"));
    const textbox = await screen.findByRole("textbox");
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());

    await act(async () => {
      refresh.reject(new ChatApiError("authorization lost", 401, null));
      await refresh.promise.catch(() => undefined);
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: AUTH_QUERY_KEY });

    fireEvent.input(textbox, { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "composer.sendTitle" }));

    await waitFor(() => expect((textbox as HTMLTextAreaElement).value).toBe("keep this draft"));
    expect(postSessionTurn).not.toHaveBeenCalled();
    expect(chatTranscriptCache.snapshot().ids).toEqual([]);
  });

  it("rejects an in-flight post invalidated by revocation without reviving chat state", async () => {
    composerHarness.useActual = true;
    const pendingPost = deferred<Awaited<ReturnType<typeof postSessionTurn>>>();
    rs.mocked(listSessionMessages).mockResolvedValue([]);
    rs.mocked(listSessionTurns).mockResolvedValueOnce([]);
    rs.mocked(postSessionTurn).mockReturnValueOnce(pendingPost.promise);

    render(renderCachedChatWithRealComposer("session-a"));
    const textbox = await screen.findByRole("textbox");
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());
    fireEvent.input(textbox, { target: { value: "pending draft" } });
    fireEvent.click(screen.getByRole("button", { name: "composer.sendTitle" }));
    await waitFor(() => expect(postSessionTurn).toHaveBeenCalledOnce());
    expect((textbox as HTMLTextAreaElement).value).toBe("");

    act(() => {
      expect(chatTranscriptCache.revokeAuthorization(context)).toBe(true);
    });
    await act(async () => {
      pendingPost.resolve({
        ok: true,
        data: { turnId: "revoked-turn", inputId: "revoked-input" },
      });
      await pendingPost.promise;
    });

    await waitFor(() => expect((textbox as HTMLTextAreaElement).value).toBe("pending draft"));
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("");
    expect(openTurnStream).not.toHaveBeenCalled();
    expect(chatTranscriptCache.snapshot().ids).toEqual([]);
  });

  it("does not restore a dropped optimistic row on the next cache hit", async () => {
    const durable = chatMessage("session-a", "durable", "2026-09-19T00:00:00.000Z");
    const optimistic = chatMessage("session-a", "optimistic-input", "2026-09-19T00:01:00.000Z");
    chatTranscriptCache.putComplete(context, "session-a", [durable, optimistic]);
    rs.mocked(listSessionTurns).mockResolvedValueOnce([]);
    rs.mocked(listSessionMessages).mockResolvedValue([durable]);
    rs.mocked(postSessionTurn).mockResolvedValueOnce({
      ok: true,
      data: { turnId: "turn-new", inputId: "optimistic-input" },
    });
    rs.mocked(openTurnStream).mockResolvedValueOnce(new Response(""));

    const view = render(renderCachedChat("session-a"));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe(
      "durable,optimistic-input",
    );

    await act(async () => {
      await composerHarness.onSend?.(
        {
          text: "replacement",
          uploads: [],
          reasoningEffort: "medium",
          projectPath: "",
        },
        { onUploadProgress: () => {}, signal: new AbortController().signal },
      );
    });
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(chatTranscriptCache.get(context, "session-a")?.map((message) => message.id)).toEqual([
        "durable",
      ]),
    );

    view.unmount();
    rs.mocked(listSessionMessages).mockReturnValue(new Promise(() => {}));
    render(renderCachedChat("session-a"));
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("durable");
  });

  it("shows a retryable error when the first history load fails", async () => {
    const user = userEvent.setup();
    const loaded = chatMessage("session-a", "loaded", "2026-09-19T00:00:00.000Z");
    rs.mocked(listSessionMessages)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([loaded]);

    render(renderCachedChat("session-a"));

    expect(await screen.findByText("history.loadFailed")).toBeTruthy();
    expect(chatTranscriptCache.get(context, "session-a")).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "history.retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("loaded"),
    );
  });

  it("removes a cached transcript before delegating a not-found response", async () => {
    const old = chatMessage("session-a", "old", "2026-09-19T00:00:00.000Z");
    const onSessionNotFound = rs.fn();
    chatTranscriptCache.putComplete(context, "session-a", [old]);
    rs.mocked(listSessionMessages).mockResolvedValue(null);

    render(renderCachedChat("session-a", { onSessionNotFound }));
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("old");

    await waitFor(() => expect(onSessionNotFound).toHaveBeenCalledWith("session-a"));
    expect(chatTranscriptCache.get(context, "session-a")).toBeUndefined();
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("");
  });

  it("terminalizes an uncached not-found load when the host has no callback", async () => {
    rs.mocked(listSessionMessages).mockResolvedValue(null);

    render(renderCachedChat("session-a"));

    expect(await screen.findByText("history.loadFailed")).toBeTruthy();
    expect(screen.queryByText("history.loading")).toBeNull();
    expect(chatTranscriptCache.get(context, "session-a")).toBeUndefined();
  });

  it("uses the initial complete load after a newer reconnect refresh fails", async () => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const initialLoad = deferred<ChatMessage[] | null>();
    const forcedRefresh = deferred<ChatMessage[] | null>();
    const loaded = chatMessage("session-a", "loaded", "2026-09-19T00:00:00.000Z");
    rs.mocked(listSessionMessages)
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(forcedRefresh.promise);

    render(renderCachedChat("session-a"));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0]!;

    act(() => {
      source.emitLifecycle("open", MockEventSource.OPEN);
      source.emitLifecycle("error", MockEventSource.CONNECTING);
      source.emitLifecycle("open", MockEventSource.OPEN);
    });
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(2));
    await act(async () => {
      forcedRefresh.reject(new Error("offline"));
      await forcedRefresh.promise.catch(() => undefined);
    });

    initialLoad.resolve([loaded]);
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("loaded"),
    );
    expect(screen.queryByText("history.loading")).toBeNull();
    expect(screen.queryByText("history.loadFailed")).toBeNull();
    expect(chatTranscriptCache.get(context, "session-a")?.map((message) => message.id)).toEqual([
      "loaded",
    ]);
  });

  it("keeps an initial complete load when a newer reconnect refresh fails afterward", async () => {
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const initialLoad = deferred<ChatMessage[] | null>();
    const forcedRefresh = deferred<ChatMessage[] | null>();
    const loaded = chatMessage("session-a", "loaded", "2026-09-19T00:00:00.000Z");
    rs.mocked(listSessionMessages)
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(forcedRefresh.promise);

    render(renderCachedChat("session-a"));
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledOnce());
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0]!;
    act(() => {
      source.emitLifecycle("open", MockEventSource.OPEN);
      source.emitLifecycle("error", MockEventSource.CONNECTING);
      source.emitLifecycle("open", MockEventSource.OPEN);
    });
    await waitFor(() => expect(listSessionMessages).toHaveBeenCalledTimes(2));

    initialLoad.resolve([loaded]);
    await waitFor(() =>
      expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("loaded"),
    );
    expect(chatTranscriptCache.get(context, "session-a")?.map((message) => message.id)).toEqual([
      "loaded",
    ]);

    await act(async () => {
      forcedRefresh.reject(new Error("offline"));
      await forcedRefresh.promise.catch(() => undefined);
    });
    expect(await screen.findByText("history.refreshFailed")).toBeTruthy();
    expect(screen.getByTestId("message-list").getAttribute("data-message-ids")).toBe("loaded");
    expect(chatTranscriptCache.get(context, "session-a")?.map((message) => message.id)).toEqual([
      "loaded",
    ]);
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
  const context = "https://rome.test|guardian:guardian-1";

  function renderDeletableChat() {
    return renderChat(
      <ChatTranscriptCacheContext.Provider value={context}>
        <Chat sessionId="session-1" />
      </ChatTranscriptCacheContext.Provider>,
    );
  }

  function seedDeletedSessionCache() {
    chatTranscriptCache.activateContext(context);
    chatTranscriptCache.putComplete(context, "session-1", [
      chatMessage("session-1", "cached-message", "2026-09-19T00:00:00.000Z"),
    ]);
  }

  it("evicts a chat only after a confirmed successful deletion", async () => {
    seedDeletedSessionCache();
    const user = userEvent.setup();
    renderDeletableChat();

    await user.click(screen.getByRole("button", { name: "navbar.more" }));
    await user.click(screen.getByRole("menuitem", { name: "navbar.delete" }));

    const dialog = screen.getByRole("dialog", { name: "navbar.delete" });
    expect(deleteSession).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "navbar.delete" }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("session-1"));
    await waitFor(() => expect(chatTranscriptCache.get(context, "session-1")).toBeUndefined());
  });

  it("keeps the cached chat when deletion returns a non-2xx response", async () => {
    seedDeletedSessionCache();
    const deletion = deferred<Response>();
    rs.mocked(deleteSession).mockReturnValue(deletion.promise);
    const user = userEvent.setup();
    renderDeletableChat();

    await user.click(screen.getByRole("button", { name: "navbar.more" }));
    await user.click(screen.getByRole("menuitem", { name: "navbar.delete" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "navbar.delete" })).getByRole("button", {
        name: "navbar.delete",
      }),
    );

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("session-1"));
    await act(async () => deletion.resolve(new Response(null, { status: 500 })));
    expect(chatTranscriptCache.get(context, "session-1")).toBeDefined();
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
