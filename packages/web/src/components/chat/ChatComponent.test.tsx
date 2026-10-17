// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { MemoryRouter, useLocation, useNavigationType, useNavigate } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { DASHBOARD_IDENTITY_QUERY_KEY } from "@/hooks/use-dashboard-identity";
import {
  readNewChatDraft,
  activateDraftOwner,
  writeNewChatDraft,
  emptyNewChatDraft,
} from "@/lib/new-chat-draft-storage";
import { useHostNavigation } from "@/hooks/use-host-navigation";
import { romeNewsConfig } from "@/config/quick-entries";
import i18n from "@/i18n";
import { ChatComponent, type ChatComponentProps, GREETING_ONLY_HOME_KEY } from "./ChatComponent";
import * as chatModule from "./Chat" with { rstest: "importActual" };
import type { ChatProps } from "./Chat";

rs.mock("@/components/logo", () => ({
  RomeLogo: (props: Record<string, unknown>) => <div data-testid="rome-logo" {...props} />,
}));

// Host-wiring tests drive Chat's callbacks through this stub. The draft tests
// mount the real Chat, because the draft composer lives inside it.
const chatStub = rs.hoisted(() => ({ enabled: false }));

function StubChat({ sessionId, mainAgentDisplayName, onSessionNotFound }: ChatProps) {
  return (
    <>
      <div data-testid="session-chat">{mainAgentDisplayName}</div>
      <button type="button" onClick={() => onSessionNotFound?.(sessionId ?? "")}>
        Missing session
      </button>
      <button type="button" onClick={() => onSessionNotFound?.("missing-child")}>
        Missing child
      </button>
    </>
  );
}

rs.mock("./Chat", () => ({
  Chat: (props: ChatProps) =>
    chatStub.enabled ? <StubChat {...props} /> : <chatModule.Chat {...props} />,
}));

// jsdom has no element scrolling, which the real hook drives on every send.
rs.mock("@/hooks/use-stick-to-bottom", () => ({
  useStickToBottom: () => ({
    contentRef: rs.fn(),
    scrollRef: rs.fn(),
    isAtBottom: true,
    scrollToBottom: rs.fn(),
  }),
}));

rs.mock("@/hooks/use-tab-status", () => ({
  useChatTabStatus: rs.fn(),
}));

rs.mock("@/components/agent-trace/TraceDrawer", () => ({
  TraceDrawer: () => null,
  traceDrawerContentInsetClass: () => "",
}));

rs.mock("@/components/chat/entries", () => ({
  renderFlatEntries: () => null,
  renderSingleEntry: () => null,
}));

rs.mock("@/components/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
  findActiveSubmission: () => null,
  findLastSubmission: () => null,
  hasPendingApprovalConfirmation: () => false,
}));

function LocationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <output data-testid="chat-location">
      {location.pathname}
      {location.search} {navigationType}
    </output>
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
  if (!crypto.randomUUID) {
    Object.defineProperty(crypto, "randomUUID", {
      value: () => "upload-id",
      configurable: true,
    });
  }
});

afterEach(async () => {
  cleanup();
  chatStub.enabled = false;
  romeNewsConfig.enabled = false;
  localStorage.clear();
  sessionStorage.clear();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

function stubCoarsePointer() {
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)",
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
}

const testNewsFeed = {
  version: 1,
  items: [
    {
      id: "cloud-news",
      type: "link",
      title: { en: "Cloud announcement", "zh-CN": "云端公告" },
      image: "https://public-assets.romeos.cc/assets/daily-summary-2.png",
      href: "/settings",
      target: "internal",
    },
  ],
};

// Passes a created session back as `sessionId`, as FreeGrid does.
function ChatHost({
  sessionId: initialSessionId,
  onSessionCreated,
  ...props
}: Partial<ChatComponentProps>) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  return (
    <ChatComponent
      {...props}
      sessionId={sessionId}
      onSessionCreated={(id) => {
        setSessionId(id);
        onSessionCreated?.(id);
      }}
    />
  );
}

function renderChatComponent(
  props: Partial<ChatComponentProps> = {},
  homeData?: {
    sessions: Array<Record<string, unknown>>;
    projects: Array<Record<string, unknown>>;
    newsFeed?: unknown;
    createSession?: () => Response | Promise<Response>;
    postTurn?: () => Response | Promise<Response>;
    settings?: Record<string, unknown>;
    // Holds the session list back until it resolves.
    sessionsGate?: Promise<void>;
  },
  initialEntry = "/chat",
  routed = false,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  queryClient.setQueryData(DASHBOARD_IDENTITY_QUERY_KEY, {
    kind: "guardian",
    userId: "synthetic-guardian",
  });
  const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url === "/api/auth/me")
      return Response.json({ kind: "guardian", userId: "synthetic-guardian" });
    if (url === "/api/settings") {
      return Response.json({ guardianName: "Ada", agentName: "Atlas", ...homeData?.settings });
    }
    if (url === "/api/people") {
      return Response.json({
        people: [],
        counts: { all: 0, guardian: 0, "inner-circle": 0, acquaintance: 0, other: 0 },
      });
    }
    if (url === "/api/chat/sessions" && init?.method === "POST") {
      return homeData?.createSession?.() ?? Response.json({ id: "new-session" });
    }
    if (url === "/api/chat/sessions") {
      await homeData?.sessionsGate;
      return Response.json(homeData?.sessions ?? []);
    }
    if (/\/api\/chat\/sessions\/[^/]+\/messages$/.test(url)) {
      return Response.json([]);
    }
    if (/\/api\/chat\/sessions\/[^/]+\/turns$/.test(url)) {
      return init?.method === "POST"
        ? (homeData?.postTurn?.() ?? Response.json({ turnId: "turn-1" }))
        : Response.json([]);
    }
    if (url === "/api/chat/projects") {
      return Response.json({
        rootPath: "/projects",
        defaultPath: "/projects/default",
        projects: homeData?.projects ?? [],
      });
    }
    if (url.endsWith("/api/rome-news")) {
      return homeData?.newsFeed === undefined
        ? Response.json({}, { status: 404 })
        : Response.json(homeData.newsFeed);
    }
    if (/\/api\/chat\/sessions\/[^/]+\/pin$/.test(url) && init?.method === "PATCH") {
      const id = url.match(/\/api\/chat\/sessions\/([^/]+)\/pin$/)?.[1];
      const target = homeData?.sessions.find((session) => session.id === id);
      if (target) target.pinnedAt = null;
      return Response.json(target ?? {});
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch);

  const result = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        {routed ? (
          <StrictMode>
            <RoutedChatHost {...props} />
          </StrictMode>
        ) : (
          <ChatHost {...props} />
        )}
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...result, fetchSpy, queryClient };
}

describe("ChatComponent draft file drops", () => {
  it("renders the send button as an icon-only control", () => {
    renderChatComponent();

    const sendButton = screen.getByRole("button", { name: "Send" });

    expect(sendButton.textContent).toBe("");
  });

  it("adds dropped files to the no-session draft composer", async () => {
    const { container } = renderChatComponent();
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const dataTransfer = {
      types: ["Files"],
      files: [file],
      items: [{ kind: "file", getAsFile: () => file }],
      dropEffect: "none",
    };

    fireEvent.dragEnter(container.firstElementChild as Element, { dataTransfer });
    expect(screen.getByText("Drop files to upload")).toBeTruthy();

    fireEvent.drop(container.firstElementChild as Element, { dataTransfer });

    expect(await screen.findByText("note.txt")).toBeTruthy();
  });
});

describe("ChatComponent agent identity", () => {
  beforeEach(() => {
    chatStub.enabled = true;
  });

  it("passes the onboarding agent name from settings into an existing chat", async () => {
    renderChatComponent({ sessionId: "session-1" });

    await waitFor(() => expect(screen.getByTestId("session-chat").textContent).toBe("Atlas"));
  });
});

describe("ChatComponent missing sessions", () => {
  beforeEach(() => {
    chatStub.enabled = true;
  });

  it.each(["", "?hideSidebar=1"])("replaces a missing chat URL with home%s", (search) => {
    renderChatComponent({ sessionId: "session-1" }, undefined, `/chat/session-1${search}`);

    fireEvent.click(screen.getByRole("button", { name: "Missing session" }));

    expect(screen.getByTestId("chat-location").textContent).toBe(`/chat${search} REPLACE`);
  });

  it("keeps the parent chat open when a handoff child is missing", () => {
    const onSessionNotFound = rs.fn();
    renderChatComponent(
      { sessionId: "session-1", onSessionNotFound },
      undefined,
      "/chat/session-1",
    );

    fireEvent.click(screen.getByRole("button", { name: "Missing child" }));

    expect(onSessionNotFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-location").textContent).toBe("/chat/session-1 POP");
  });

  it("lets a pinned chat remove its card without leaving the current page", () => {
    const onSessionNotFound = rs.fn();
    renderChatComponent(
      { sessionId: "pinned-session", onSessionNotFound },
      undefined,
      "/chat/main",
    );

    fireEvent.click(screen.getByRole("button", { name: "Missing session" }));

    expect(onSessionNotFound).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("chat-location").textContent).toBe("/chat/main POP");
  });
});

describe("ChatComponent empty home", () => {
  it("focuses the draft composer so typing works without a click", async () => {
    const user = userEvent.setup();
    renderChatComponent();

    const composer = screen.getByRole("textbox");
    expect(document.activeElement).toBe(composer);

    await user.keyboard("Hello Rome");
    expect((composer as HTMLTextAreaElement).value).toBe("Hello Rome");
  });

  it("does not autofocus the draft composer on touch devices", () => {
    stubCoarsePointer();
    renderChatComponent();

    expect(document.activeElement).not.toBe(screen.getByRole("textbox"));
  });

  it("prefills a draft without focusing the composer on touch devices", () => {
    stubCoarsePointer();
    renderChatComponent({ initialDraftText: "Plan a trip" });

    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(composer.value).toBe("Plan a trip");
    expect(document.activeElement).not.toBe(composer);
  });

  it("shows scrollable pinned chats and Rome News", async () => {
    romeNewsConfig.enabled = true;
    const user = userEvent.setup();
    const homeData = {
      sessions: [
        {
          id: "session-pinned",
          name: "Pinned planning chat",
          personaId: null,
          projectName: "alpha",
          projectPath: "alpha",
          agentName: null,
          archivedAt: null,
          pinnedAt: "2026-07-24T12:00:00.000Z",
          createdAt: "2026-07-24T10:00:00.000Z",
          activityAt: "2026-07-24T12:00:00.000Z",
          lastSeenActivityAt: null,
          unread: false,
          messageCount: 2,
        },
        {
          id: "session-pinned-2",
          name: "Pinned launch chat",
          personaId: null,
          projectName: "",
          projectPath: "",
          agentName: null,
          archivedAt: null,
          pinnedAt: "2026-07-24T11:00:00.000Z",
          createdAt: "2026-07-24T09:00:00.000Z",
          activityAt: "2026-07-24T11:00:00.000Z",
          lastSeenActivityAt: null,
          unread: false,
          messageCount: 1,
        },
      ],
      projects: [
        {
          name: "alpha",
          displayName: "Alpha project",
          projectPath: "alpha",
          path: "/projects/alpha",
        },
      ],
      newsFeed: testNewsFeed,
    };

    const { fetchSpy } = renderChatComponent({}, homeData);

    expect(await screen.findByText("Hi Ada,")).toBeTruthy();
    expect(await screen.findByText("Pinned planning chat")).toBeTruthy();
    expect(screen.getByText("Pinned launch chat")).toBeTruthy();
    expect(screen.queryByText("Pinned projects")).toBeNull();
    expect(screen.queryByText("Alpha project")).toBeNull();
    expect(screen.getByRole("heading", { name: "Pinned chats" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Rome News" })).toBeTruthy();

    const pinnedRail = document.querySelector('[data-horizontal-scroll="pinned-chats"]');
    expect(pinnedRail?.children).toHaveLength(2);
    expect(screen.queryByText("Ideas and shortcuts")).toBeNull();

    if (!(pinnedRail instanceof HTMLElement)) throw new Error("Pinned chat rail was not rendered");
    Object.defineProperty(pinnedRail, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(pinnedRail, "scrollWidth", { configurable: true, value: 800 });

    fireEvent.scroll(pinnedRail);
    expect(pinnedRail.dataset.scrollLeft).toBe("false");
    expect(pinnedRail.dataset.scrollRight).toBe("true");
    expect(pinnedRail.style.getPropertyValue("--scroll-fade-mask")).toBe(
      "linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)",
    );

    pinnedRail.scrollLeft = 200;
    fireEvent.scroll(pinnedRail);
    expect(pinnedRail.dataset.scrollLeft).toBe("true");
    expect(pinnedRail.dataset.scrollRight).toBe("true");
    expect(pinnedRail.style.getPropertyValue("--scroll-fade-mask")).toBe(
      "linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%)",
    );

    pinnedRail.scrollLeft = 500;
    fireEvent.scroll(pinnedRail);
    expect(pinnedRail.dataset.scrollLeft).toBe("true");
    expect(pinnedRail.dataset.scrollRight).toBe("false");
    expect(pinnedRail.style.getPropertyValue("--scroll-fade-mask")).toBe(
      "linear-gradient(to right, transparent 0, black 24px, black 100%)",
    );
    expect(pinnedRail.parentElement?.querySelector("[data-scroll-edge]")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Unpin Pinned planning chat" }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/chat/sessions/session-pinned/pin" &&
            init?.method === "PATCH" &&
            String(init.body).includes('"pinned":false'),
        ),
      ).toBe(true),
    );
  });

  it("uses the complete Rome Cloud feed and resolves locale in the browser", async () => {
    romeNewsConfig.enabled = true;
    const { fetchSpy } = renderChatComponent(
      {},
      {
        sessions: [],
        projects: [],
        newsFeed: {
          version: 1,
          items: [
            {
              id: "cloud-news",
              type: "link",
              title: { en: "Cloud announcement", "zh-CN": "云端公告" },
              subtitle: {
                en: "One payload for every locale",
                "zh-CN": "一份数据包含所有语言",
              },
              image: "https://public-assets.romeos.cc/assets/daily-summary-2.png",
              href: "/settings",
              target: "internal",
            },
          ],
        },
      },
    );

    expect(await screen.findByText("Cloud announcement")).toBeTruthy();

    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    expect(await screen.findByText("云端公告")).toBeTruthy();

    const newsRequests = fetchSpy.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/rome-news"),
    );
    expect(newsRequests).toHaveLength(1);
    expect(String(newsRequests[0][0])).not.toContain("locale=");
  });

  it("does not fetch or show Rome News while it is disabled", async () => {
    const { fetchSpy } = renderChatComponent(
      {},
      { sessions: [], projects: [], newsFeed: testNewsFeed },
    );

    expect(await screen.findByText("Hi Ada,")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Rome News" })).toBeNull();
    expect(fetchSpy.mock.calls.some(([input]) => String(input).endsWith("/api/rome-news"))).toBe(
      false,
    );
  });

  const pinnedSession = {
    id: "session-pinned",
    name: "Pinned planning chat",
    personaId: null,
    projectName: "",
    projectPath: "",
    agentName: null,
    archivedAt: null,
    pinnedAt: "2026-07-24T12:00:00.000Z",
    createdAt: "2026-07-24T10:00:00.000Z",
    activityAt: "2026-07-24T12:00:00.000Z",
    lastSeenActivityAt: null,
    unread: false,
    messageCount: 2,
  };
  const centerSpacer = () => document.querySelector("[data-draft-center-spacer]");

  it("centers the composer with a greeting-only home and remembers it", async () => {
    renderChatComponent({}, { sessions: [], projects: [] });

    expect(await screen.findByText("Hi Ada,")).toBeTruthy();
    expect(centerSpacer()).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem(GREETING_ONLY_HOME_KEY)).toBe("true"));
  });

  it("docks the composer beside pinned chats and remembers it", async () => {
    renderChatComponent({}, { sessions: [pinnedSession], projects: [] });

    expect(await screen.findByText("Pinned planning chat")).toBeTruthy();
    expect(centerSpacer()).toBeNull();
    await waitFor(() => expect(localStorage.getItem(GREETING_ONLY_HOME_KEY)).toBe("false"));
  });

  it("keeps the remembered docked layout while the sessions load", async () => {
    localStorage.setItem(GREETING_ONLY_HOME_KEY, "false");
    let releaseSessions = () => {};
    const sessionsGate = new Promise<void>((resolve) => {
      releaseSessions = resolve;
    });
    renderChatComponent({}, { sessions: [pinnedSession], projects: [], sessionsGate });

    expect(await screen.findByText("Hi Ada,")).toBeTruthy();
    expect(centerSpacer()).toBeNull();

    releaseSessions();
    expect(await screen.findByText("Pinned planning chat")).toBeTruthy();
    expect(centerSpacer()).toBeNull();
  });

  it("hides Rome News when Rome Cloud publishes an empty feed", async () => {
    romeNewsConfig.enabled = true;
    renderChatComponent(
      {},
      {
        sessions: [],
        projects: [],
        newsFeed: { version: 1, items: [] },
      },
    );

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Rome News" })).toBeNull());
  });

  it("executes chat, App Store, and link actions from Cloud definitions", async () => {
    romeNewsConfig.enabled = true;
    const user = userEvent.setup();
    const openSpy = rs.spyOn(window, "open").mockImplementation(() => null);
    const image = "https://public-assets.romeos.cc/assets/daily-summary-2.png";
    renderChatComponent(
      {},
      {
        sessions: [],
        projects: [],
        newsFeed: {
          version: 1,
          items: [
            {
              id: "cloud-chat",
              type: "chat",
              title: { en: "Cloud chat", "zh-CN": "云端聊天" },
              image,
              prompt: { en: "Draft from Cloud", "zh-CN": "从云端起草" },
              mode: "draft",
            },
            {
              id: "cloud-store",
              type: "app-store",
              title: { en: "Cloud App Store", "zh-CN": "云端应用商店" },
              image,
              url: "https://romeos.cc/store/rome/example",
            },
            {
              id: "cloud-link",
              type: "link",
              title: { en: "Cloud link", "zh-CN": "云端链接" },
              image,
              href: "https://romeos.cc/blog",
              target: "external",
            },
          ],
        },
      },
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "existing user draft" } });
    await user.click(await screen.findByRole("button", { name: "Cloud chat" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Draft from Cloud");

    await user.click(screen.getByRole("button", { name: "Cloud App Store" }));
    expect(screen.getByTitle("App store").getAttribute("src")).toBe(
      "https://romeos.cc/store/rome/example",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Cloud link" }));
    expect(openSpy).toHaveBeenCalledWith("https://romeos.cc/blog", "_blank", "noopener,noreferrer");
  });
});

describe("ChatComponent first send", () => {
  it("independent start quick-entry does not save its prompt over an unrelated draft", async () => {
    romeNewsConfig.enabled = true;
    const { fetchSpy } = renderChatComponent(
      {},
      {
        sessions: [],
        projects: [],
        newsFeed: {
          version: 1,
          items: [
            {
              id: "synthetic-start",
              type: "chat",
              title: { en: "Start independently", "zh-CN": "独立开始" },
              image: "https://example.com/synthetic.png",
              prompt: { en: "independent prompt", "zh-CN": "独立提示" },
              mode: "start",
              skillName: "independent_skill",
            },
          ],
        },
      },
    );
    const raw = "  unrelated raw中文🙂\n  ";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: raw } });
    await userEvent.click(await screen.findByRole("button", { name: "Start independently" }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) => String(url).endsWith("/turns") && init?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(readNewChatDraft("guardian:synthetic-guardian")?.value.text).toBe(raw);
    const posted = fetchSpy.mock.calls.find(
      ([url, init]) => String(url).endsWith("/turns") && init?.method === "POST",
    )!;
    expect((posted[1]?.body as FormData).get("text")).toBe("independent prompt");
    expect((posted[1]?.body as FormData).get("skillName")).toBe("independent_skill");
  });

  it("keeps the focused composer through the session the first send creates", async () => {
    const user = userEvent.setup();
    const onSessionCreated = rs.fn();
    const { fetchSpy } = renderChatComponent({ onSessionCreated });
    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(composer);

    await user.keyboard("Hello Rome{Enter}");

    expect(await screen.findByTestId("message-list")).toBeTruthy();
    expect(onSessionCreated).toHaveBeenCalledWith("new-session");
    const turnPost = fetchSpy.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/chat/sessions/new-session/turns" && init?.method === "POST",
    );
    expect((turnPost?.[1]?.body as FormData | undefined)?.get("text")).toBe("Hello Rome");
    expect(screen.getByRole("textbox")).toBe(composer);
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe("");
  });

  it("keeps the draft and restores the input when the session cannot be created", async () => {
    const user = userEvent.setup();
    const onSessionCreated = rs.fn();
    const { fetchSpy } = renderChatComponent(
      { onSessionCreated },
      {
        sessions: [],
        projects: [],
        createSession: () => Response.json({ error: "Chat limit reached" }, { status: 500 }),
      },
    );
    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;

    await user.keyboard("Hello Rome{Enter}");

    expect(await screen.findByText("Chat limit reached")).toBeTruthy();
    expect(composer.value).toBe("Hello Rome");
    expect(screen.getByRole("textbox")).toBe(composer);
    expect(screen.queryByTestId("message-list")).toBeNull();
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith("/turns"))).toBe(false);
  });
});

function RoutedChatHost({ onSessionCreated, ...props }: Partial<ChatComponentProps>) {
  const location = useLocation();
  const navigate = useNavigate();
  useHostNavigation();
  const sessionId = location.pathname.startsWith("/chat/") ? location.pathname.slice(6) : undefined;
  return (
    <>
      <button onClick={() => navigate("/other")}>Other route</button>
      <button onClick={() => navigate("/chat/existing")}>Existing session</button>
      <button onClick={() => navigate("/chat")}>New chat route</button>
      <button onClick={() => navigate(-1)}>Back</button>
      {location.pathname !== "/other" && (
        <ChatComponent
          {...props}
          sessionId={sessionId}
          initialDraftText={(location.state as { draft?: string } | null)?.draft}
          onSessionCreated={(id) => {
            navigate(`/chat/${id}`);
            onSessionCreated?.(id);
          }}
        />
      )}
    </>
  );
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("retained draft through the real Chat route and first-send path", () => {
  it("unmounted failed create restores only an unedited remount, without late navigation", async () => {
    const creation = deferredResponse();
    const created = rs.fn();
    renderChatComponent(
      { onSessionCreated: created },
      { sessions: [], projects: [], createSession: () => creation.promise },
      "/chat",
      true,
    );
    const raw = "  failed create中文🙂\n  ";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: raw } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Other route" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat route" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    await act(async () =>
      creation.resolve(Response.json({ error: "synthetic failure" }, { status: 500 })),
    );
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(raw),
    );
    expect(created).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-location").textContent).toContain("/chat ");
  });

  it("new remount typing then deletion survives old POST rejection", async () => {
    const post = deferredResponse();
    renderChatComponent(
      {},
      { sessions: [], projects: [], postTurn: () => post.promise },
      "/chat",
      true,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "old A" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("chat-location").textContent).toContain("/chat/new-session"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Other route" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat route" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new B" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    await act(async () => post.resolve(Response.json({ error: "rejected" }, { status: 500 })));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(readNewChatDraft("guardian:synthetic-guardian")?.value.text).toBe("");
  });

  it("public identity switch clears old content without refocusing a coarse pointer", async () => {
    stubCoarsePointer();
    activateDraftOwner("guardian:late");
    const raw = "  later identity中文🙂\n  ";
    writeNewChatDraft("guardian:late", { ...emptyNewChatDraft(), text: raw });
    const { queryClient } = renderChatComponent({}, undefined, "/chat", true);
    // Query identity changes are synthetic; there is no real account operation.
    act(() =>
      queryClient.setQueryData(DASHBOARD_IDENTITY_QUERY_KEY, { kind: "guardian", userId: "late" }),
    );
    // A confirmed identity switch intentionally clears old content, unlike first hydration.
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""),
    );
    expect(document.activeElement).not.toBe(screen.getByRole("textbox"));
  });

  it.each([
    "Existing session",
    "Other route",
  ])("restores the raw-end caret after %s and immediately appends typing", async (route) => {
    const user = userEvent.setup();
    renderChatComponent({}, undefined, "/chat", true);
    const raw = "  中文🙂\n第二行\n  ";
    const original = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(original, { target: { value: raw } });
    original.setSelectionRange(2, 2);
    fireEvent.click(screen.getByRole("button", { name: route }));
    fireEvent.click(screen.getByRole("button", { name: "New chat route" }));
    const restored = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(restored.value).toBe(raw);
    expect(document.activeElement).toBe(restored);
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([raw.length, raw.length]);
    await user.keyboard("追加🙂");
    expect(restored.value).toBe(raw + "追加🙂");
  });

  it.each([
    false,
    true,
  ])("positions seeded and restored content only on entry (coarse pointer: %s)", async (coarse) => {
    if (coarse) stubCoarsePointer();
    const user = userEvent.setup();
    const { queryClient } = renderChatComponent({}, undefined, "/chat", true);
    const raw = "  中文🙂\n第二行\n  ";
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("rome:host-navigate", { detail: { path: "/chat", state: { draft: raw } } }),
      );
    });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe(raw);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([raw.length, raw.length]);
    if (coarse) expect(document.activeElement).not.toBe(textarea);

    textarea.focus();
    textarea.setSelectionRange(2, 4);
    fireEvent.select(textarea);
    act(() =>
      queryClient.setQueryData(["settings"], { guardianName: "Updated name", agentName: "Atlas" }),
    );
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 4]);
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 4]);
    fireEvent.compositionEnd(textarea);
    await user.keyboard("追加");
    const edited = raw.slice(0, 2) + "追加" + raw.slice(4);
    expect(textarea.value).toBe(edited);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([4, 4]);

    fireEvent.click(screen.getByRole("button", { name: "Other route" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat route" }));
    const restored = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([
      edited.length,
      edited.length,
    ]);
    if (coarse) expect(document.activeElement).not.toBe(restored);
  });

  it("preserves raw text on existing-session/other-route/repeated New chat and respects deletion", async () => {
    renderChatComponent({}, undefined, "/chat", true);
    const raw = "  中文\n第二行\n  ";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: raw } });
    fireEvent.click(screen.getByRole("button", { name: "Existing session" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat route" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Other route" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat route" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat route" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(raw);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Other route" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat route" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the same focused textarea and navigates before POST acceptance", async () => {
    const post = deferredResponse();
    const onSessionCreated = rs.fn();
    renderChatComponent(
      { onSessionCreated },
      { sessions: [], projects: [], postTurn: () => post.promise },
      "/chat",
      true,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.change(textarea, { target: { value: "first message" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith("new-session"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-location").textContent).toContain("/chat/new-session"),
    );
    expect(screen.getByRole("textbox")).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("");
    await act(async () => post.resolve(Response.json({ turnId: "turn-1" })));
    // The synthetic stream read returns 404. An accepted input stays sent.
    await waitFor(() => expect(textarea.value).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "New chat route" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("consumes each real navigation seed once, silently ignores conflicts, and allows a fresh seed after deletion", async () => {
    renderChatComponent({}, undefined, "/chat", true);
    const prefill = async (draft: string) =>
      act(async () => {
        window.dispatchEvent(
          new CustomEvent("rome:host-navigate", { detail: { path: "/chat", state: { draft } } }),
        );
      });
    await prefill("original seed");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "edited seed" } });
    fireEvent.click(screen.getByRole("button", { name: "Other route" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("edited seed");
    await prefill("conflicting seed");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("edited seed");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Other route" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    await prefill("fresh seed");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("fresh seed");
  });
});
