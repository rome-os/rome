// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { romeNewsConfig } from "@/config/quick-entries";
import { loadNewChatDraft, saveNewChatDraft } from "@/lib/new-chat-draft-storage";
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
    <output data-testid="chat-location" data-state={JSON.stringify(location.state)}>
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
  const { state } = useLocation();
  return (
    <ChatComponent
      initialDraftText={state?.draft}
      initialSkillName={state?.skill}
      initialProjectName={state?.projectPath}
      initialAgentMention={state?.agentMention}
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
    postTurn?: () => Response;
    // Holds the Rome News feed back until it resolves.
    newsGate?: Promise<void>;
  },
  initialEntry: string | { pathname: string; state: Record<string, unknown> } = "/chat",
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url === "/api/settings") {
      return Response.json({ guardianName: "Ada", agentName: "Atlas" });
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
      await homeData?.newsGate;
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
        <ChatHost {...props} />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...result, fetchSpy };
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

  it("shows Rome News but not pinned chats, which live in the sidebar", async () => {
    romeNewsConfig.enabled = true;
    renderChatComponent({}, { sessions: [pinnedSession], projects: [], newsFeed: testNewsFeed });

    expect(await screen.findByText("Hi Ada,")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Rome News" })).toBeTruthy();
    expect(screen.queryByText("Pinned planning chat")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Pinned chats" })).toBeNull();
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

  const centerSpacer = () => document.querySelector("[data-draft-center-spacer]");

  it("centers the composer with a greeting-only home and remembers it", async () => {
    renderChatComponent({}, { sessions: [], projects: [] });

    expect(await screen.findByText("Hi Ada,")).toBeTruthy();
    expect(centerSpacer()).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem(GREETING_ONLY_HOME_KEY)).toBe("true"));
  });

  it("keeps the composer centered with only pinned chats, and remembers it", async () => {
    renderChatComponent({}, { sessions: [pinnedSession], projects: [] });

    expect(await screen.findByText("Hi Ada,")).toBeTruthy();
    expect(centerSpacer()).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem(GREETING_ONLY_HOME_KEY)).toBe("true"));
  });

  it("docks the composer beside Rome News and remembers it", async () => {
    romeNewsConfig.enabled = true;
    renderChatComponent({}, { sessions: [], projects: [], newsFeed: testNewsFeed });

    expect(await screen.findByText("Cloud announcement")).toBeTruthy();
    expect(centerSpacer()).toBeNull();
    await waitFor(() => expect(localStorage.getItem(GREETING_ONLY_HOME_KEY)).toBe("false"));
  });

  it("keeps the remembered docked layout while Rome News loads", async () => {
    romeNewsConfig.enabled = true;
    localStorage.setItem(GREETING_ONLY_HOME_KEY, "false");
    let releaseNews = () => {};
    const newsGate = new Promise<void>((resolve) => {
      releaseNews = resolve;
    });
    renderChatComponent({}, { sessions: [], projects: [], newsFeed: testNewsFeed, newsGate });

    expect(await screen.findByText("Hi Ada,")).toBeTruthy();
    expect(centerSpacer()).toBeNull();

    releaseNews();
    expect(await screen.findByText("Cloud announcement")).toBeTruthy();
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
    expect(loadNewChatDraft()?.text).toBe("Hello Rome");
    expect(screen.getByRole("textbox")).toBe(composer);
    expect(screen.queryByTestId("message-list")).toBeNull();
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith("/turns"))).toBe(false);
  });
});

describe("New chat draft boundaries", () => {
  it("replaces explicit prefill fields and consumes history state", async () => {
    saveNewChatDraft({
      version: 1,
      text: "saved",
      projectPath: "old-project",
      agentMention: null,
      skill: { name: "old-skill" },
      personaId: "",
    });
    const agentMention = { appId: "app", agentName: "agent", appLabel: "App" };
    renderChatComponent({}, undefined, {
      pathname: "/chat",
      state: { draft: "explicit", skill: "new-skill", projectPath: "new-project", agentMention },
    });
    await waitFor(() =>
      expect(loadNewChatDraft()).toMatchObject({
        text: "explicit",
        projectPath: "new-project",
        skill: { name: "new-skill" },
        agentMention,
      }),
    );
    expect(screen.getByTestId("chat-location").getAttribute("data-state")).toBe("null");
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "edited" } });
    expect(loadNewChatDraft()?.text).toBe("edited");
  });

  it("consumes prefill and widget keys while preserving other history state", async () => {
    const otherState = { futureKey: { keep: true } };
    renderChatComponent({}, undefined, {
      pathname: "/chat",
      state: {
        ...otherState,
        widgets: [{ type: "app", appId: "app" }],
        draft: "explicit",
        skill: "skill",
        projectPath: "project",
        agentMention: { appId: "app", agentName: "agent", appLabel: "App" },
        agentName: "agent",
      },
    });
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("chat-location").getAttribute("data-state")!)).toEqual(
        otherState,
      ),
    );
    expect(loadNewChatDraft()?.text).toBe("explicit");
  });

  it("text-only prefill removes the saved skill", async () => {
    saveNewChatDraft({
      version: 1,
      text: "saved",
      projectPath: "default",
      agentMention: null,
      skill: { name: "old-skill" },
      personaId: "",
    });
    renderChatComponent({}, undefined, { pathname: "/chat", state: { draft: "explicit" } });
    await waitFor(() =>
      expect(loadNewChatDraft()).toMatchObject({ text: "explicit", skill: null }),
    );
    expect(screen.queryByRole("button", { name: "Remove skill" })).toBeNull();
  });

  it("skill-only prefill keeps the saved text", async () => {
    saveNewChatDraft({
      version: 1,
      text: "unsent task",
      projectPath: "default",
      agentMention: null,
      skill: null,
      personaId: "",
    });
    renderChatComponent({}, undefined, { pathname: "/chat", state: { skill: "new-skill" } });
    await waitFor(() =>
      expect(loadNewChatDraft()).toMatchObject({
        text: "unsent task",
        skill: { name: "new-skill" },
      }),
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("unsent task");
  });

  it("does not resurrect a failed first turn after the session exists and a retry succeeds", async () => {
    let attempts = 0;
    renderChatComponent(
      {},
      {
        sessions: [],
        projects: [],
        postTurn: () =>
          ++attempts === 1
            ? Response.json({ error: "try again" }, { status: 500 })
            : Response.json({ turnId: "turn-1" }),
      },
    );
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "retry me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("retry me"),
    );
    expect(loadNewChatDraft()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(loadNewChatDraft()).toBeNull();
  });

  it("posts the first turn even if navigation unmounts the composer during creation", async () => {
    let resolveCreate!: (response: Response) => void;
    const creation = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const { unmount, fetchSpy } = renderChatComponent(
      {},
      { sessions: [], projects: [], createSession: () => creation },
    );
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "complete this send" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    unmount();
    await act(async () => resolveCreate(Response.json({ id: "created-after-leaving" })));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/chat/sessions/created-after-leaving/turns" &&
            init?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(loadNewChatDraft()).toBeNull();
  });
});
