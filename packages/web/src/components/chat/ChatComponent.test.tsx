// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState } from "react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ThemeProvider } from "@/hooks/use-theme";
import { romeNewsConfig } from "@/config/quick-entries";
import { LAST_CONCIERGE_KEY, seedChatListMode } from "@/test/chat-list-mode";
import { loadNewChatDraft, saveNewChatDraft } from "@/lib/new-chat-draft-storage";
import i18n from "@/i18n";
import { ChatComponent, type ChatComponentProps, GREETING_ONLY_HOME_KEY } from "./ChatComponent";
import * as chatModule from "./Chat" with { rstest: "importActual" };
import type { ChatProps } from "./Chat";
import * as listModule from "./MessageList" with { rstest: "importActual" };
import type { MessageListProps } from "./MessageList";
import { useChatThreads } from "./reply/chat-threads";
import { ToolTraceContext, type ToolTraceHost } from "@/pages/free/tool-trace";

rs.mock("@/components/logo", () => ({
  RomeLogo: (props: Record<string, unknown>) => <div data-testid="rome-logo" {...props} />,
}));

// Host-wiring tests drive Chat's callbacks through this stub. The draft tests
// mount the real Chat, because the draft composer lives inside it.
const chatStub = rs.hoisted(() => ({ enabled: false }));

function StubChat({
  sessionId,
  mainAgentDisplayName,
  onSessionNotFound,
  variant,
  conciergeName,
}: ChatProps) {
  return (
    <>
      <div
        data-testid="session-chat"
        data-variant={variant ?? "default"}
        data-concierge-name={conciergeName}
      >
        {mainAgentDisplayName}
      </div>
      <button type="button" onClick={() => onSessionNotFound?.(sessionId ?? "")}>
        Missing session
      </button>
      <button type="button" onClick={() => onSessionNotFound?.("missing-other")}>
        Missing other
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
}));

rs.mock("@/components/chat/entries", () => ({
  renderFlatEntries: () => null,
  renderSingleEntry: () => null,
}));

const transcriptFrames = rs.hoisted(
  () =>
    [] as Array<{
      ids: string[];
      stacked: string[];
      variant: MessageListProps["variant"];
    }>,
);

function TranscriptProbe({ rows, variant }: MessageListProps) {
  const threads = useChatThreads();
  const ids = rows.flatMap((row) => (row.kind === "user" ? [row.message.id] : []));
  useLayoutEffect(() => {
    if (ids.length > 0)
      transcriptFrames.push({ ids, stacked: [...(threads?.stacked ?? [])], variant });
  });
  return <div data-testid="message-list" data-variant={variant} data-message-ids={ids.join(",")} />;
}

// The cold-start tests draw the real transcript, to see what each frame shows.
const realList = rs.hoisted(() => ({ enabled: false }));
rs.mock("@/components/chat/MessageList", () => ({
  MessageList: (props: MessageListProps) =>
    realList.enabled ? <listModule.MessageList {...props} /> : <TranscriptProbe {...props} />,
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
  realList.enabled = false;
  transcriptFrames.length = 0;
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

// The chat always sits in a tool workspace; this one has a collapsed pane.
const toolPane: ToolTraceHost = {
  outlet: null,
  paneOpen: false,
  setPaneCollapsed: () => {},
  reveal: () => {},
  set: () => {},
};

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
    settings?: Record<string, unknown>;
    // Answers `/api/concierge/session` once it resolves; a chat's messages 404 until then.
    conciergeCreated?: Promise<void>;
    conciergeChatsGate?: Promise<void>;
    messagePage?: (url: string) => unknown;
    // Answers the Concierge paging mode of a chat as one that is not a Concierge chat does.
    refuseConcierge?: boolean;
  },
  initialEntry: string | { pathname: string; state: Record<string, unknown> } = "/chat",
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  let conciergeExists = !homeData?.conciergeCreated;
  const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url === "/api/settings") {
      return Response.json({ guardianName: "Ada", agentName: "Atlas", ...homeData?.settings });
    }
    if (url === "/api/concierge/chats") {
      await homeData?.conciergeChatsGate;
      return Response.json({
        chats: [
          { id: "concierge", name: "Concierge", main: true, unread: 0 },
          { id: "topic-1", name: "Calendar", main: false, unread: 0 },
        ],
      });
    }
    if (url === "/api/concierge/session") {
      await homeData?.conciergeCreated;
      conciergeExists = true;
      return Response.json({ id: "concierge", unread: 0 });
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
    if (/\/api\/chat\/sessions\/[^/]+\/messages(\?.*)?$/.test(url)) {
      if (url.includes("/concierge/messages") && !conciergeExists) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      if (homeData?.refuseConcierge && url.includes("type=concierge")) {
        return Response.json(
          { error: "Not a Concierge chat", code: "not_concierge" },
          { status: 400 },
        );
      }
      // A chat with nothing said answers the Concierge paging mode with nothing.
      const nothing = url.includes("type=concierge")
        ? {
            type: "concierge",
            mainLine: [],
            outside: [],
            traces: [],
            nextCursor: null,
            hasMore: false,
          }
        : { messages: [], nextCursor: null };
      return url.includes("limit=")
        ? Response.json((await homeData?.messagePage?.(url)) ?? nothing)
        : Response.json([]);
    }
    if (/\/api\/chat\/sessions\/[^/]+\/turns$/.test(url)) {
      return init?.method === "POST"
        ? (homeData?.postTurn?.() ?? Response.json({ turnId: "turn-1" }))
        : Response.json([]);
    }
    if (url === "/api/chat/locations") {
      return Response.json({
        projects: {
          rootPath: "/projects",
          defaultPath: "/projects/default",
          projects: homeData?.projects ?? [],
        },
        devices: null,
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
        <ThemeProvider>
          <ToolTraceContext.Provider value={toolPane}>
            <ChatHost {...props} />
          </ToolTraceContext.Provider>
        </ThemeProvider>
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

describe("ChatComponent topic chat reload", () => {
  const stamp = (n: number) => new Date(Date.UTC(2026, 10, 9, 9, n)).toISOString();
  const root = {
    id: "root",
    sessionId: "topic-1",
    turnId: "turn-1",
    role: "user" as const,
    content: JSON.stringify([{ type: "text", content: "Plan a trip" }]),
    createdAt: stamp(0),
    chatThreadId: "root",
    read: true,
  };
  const reply = {
    ...root,
    id: "reply",
    turnId: "turn-2",
    role: "assistant" as const,
    content: JSON.stringify([{ type: "text", content: "Booked it" }]),
    createdAt: stamp(5),
    read: false,
  };
  // What the screen holds at each change of the document: a chat is drawn as
  // a Concierge chat, or as another, and which one tells by its bubbles.
  function watchFrames() {
    const seen = { concierge: false, other: false, pending: false };
    const look = () => {
      const text = document.body.textContent ?? "";
      if (document.querySelector("[data-chat-pending]")) seen.pending = true;
      if (document.querySelector("[data-thread-entry]")) seen.concierge = true;
      else if (text.includes("Plan a trip")) seen.other = true;
    };
    const observer = new MutationObserver(look);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return { seen, stop: () => observer.disconnect() };
  }

  it("draws a topic chat once, as a Concierge chat, from the one read that tells what it is", async () => {
    realList.enabled = true;
    let releaseChats!: () => void;
    const conciergeChatsGate = new Promise<void>((resolve) => {
      releaseChats = resolve;
    });
    // The thread comes with the root as a summary: its newest reply, which stacks.
    const messagePage = rs.fn((_url: string) => ({
      type: "concierge",
      mainLine: [{ message: root, thread: { replyCount: 1, unreadCount: 1, latestReply: reply } }],
      outside: [],
      traces: [],
      nextCursor: null,
      hasMore: false,
    }));
    const frames = watchFrames();
    renderChatComponent(
      { sessionId: "topic-1" },
      { sessions: [], projects: [], conciergeChatsGate, messagePage },
      "/chat/topic-1",
    );

    // Nothing of a chat is drawn while the one read is on its way.
    expect(document.querySelector("[data-chat-pending]")).not.toBeNull();
    expect(document.querySelector("[data-thread-entry]")).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-thread-entry]")).not.toBeNull());
    // The list has not named the chat, and its first frame already stacks and has its pill.
    expect(document.querySelector('[data-thread-stack="root"]')).not.toBeNull();
    expect(document.querySelector('[data-thread-entry="reply"]')).toBeNull();
    expect(document.querySelector('[data-thread-pill="root"]')).not.toBeNull();
    await act(async () => releaseChats());
    await act(async () => {});
    frames.stop();

    expect(frames.seen).toEqual({ concierge: true, other: false, pending: true });
    expect(messagePage).toHaveBeenCalledOnce();
    expect(messagePage.mock.calls[0]?.[0]).toContain("type=concierge");
    expect(messagePage.mock.calls[0]?.[0]).toContain("limit=40");
  });

  it("draws a chat that is not a Concierge chat once, after its refusal, by turns", async () => {
    realList.enabled = true;
    const fetchTurns = rs.fn();
    const frames = watchFrames();
    const { fetchSpy } = renderChatComponent(
      { sessionId: "session-1" },
      {
        sessions: [],
        projects: [],
        messagePage: (url) => {
          fetchTurns(url);
          return {
            messages: [{ ...root, sessionId: "session-1", chatThreadId: null }],
            nextCursor: null,
          };
        },
        // A chat that is not a Concierge chat refuses the paging mode.
        refuseConcierge: true,
      },
      "/chat/session-1",
    );

    await waitFor(() => expect(document.body.textContent).toContain("Plan a trip"));
    frames.stop();

    expect(document.querySelector("[data-thread-entry]")).toBeNull();
    expect(frames.seen.concierge).toBe(false);
    expect(frames.seen.pending).toBe(true);
    const asked = fetchSpy.mock.calls
      .map(([input]) => String(input))
      .filter((url) => /\/messages\?/.test(url));
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain("type=concierge");
    expect(asked[1]).not.toContain("type=concierge");
    expect(asked[1]).toContain("limit=10");
  });
});

describe("ChatComponent Concierge chats", () => {
  beforeEach(() => {
    chatStub.enabled = true;
  });

  it("shows a topic chat as a Concierge chat, and an ordinary chat as one of its own", async () => {
    renderChatComponent({ sessionId: "topic-1" }, { sessions: [], projects: [] }, "/chat/topic-1");
    await waitFor(() =>
      expect(screen.getByTestId("session-chat").getAttribute("data-variant")).toBe("concierge"),
    );
    cleanup();
    renderChatComponent(
      { sessionId: "session-1" },
      { sessions: [], projects: [] },
      "/chat/session-1",
    );
    await act(async () => {});
    expect(screen.getByTestId("session-chat").getAttribute("data-variant")).toBe("default");
  });
});

describe("ChatComponent Concierge name", () => {
  beforeEach(() => {
    chatStub.enabled = true;
  });

  it.each([
    ["the agent name the guardian chose", " Milo ", "Milo"],
    ["Rome when the agent name is blank", "  ", "Rome"],
  ])("hands Chat %s", async (_label, agentName, expected) => {
    renderChatComponent(
      { sessionId: "concierge" },
      { sessions: [], projects: [], settings: { agentName } },
      "/chat/concierge",
    );
    await waitFor(() =>
      expect(screen.getByTestId("session-chat").getAttribute("data-concierge-name")).toBe(expected),
    );
  });
});

describe("ChatComponent topic chat draft", () => {
  beforeEach(() => {
    chatStub.enabled = false;
  });

  it("opens blank with the Concierge layout, and its first send creates a topic chat", async () => {
    const posted: Array<{ url: string; body: unknown }> = [];
    const onSessionCreated = rs.fn();
    const { fetchSpy } = renderChatComponent(
      { onSessionCreated },
      { sessions: [], projects: [] },
      { pathname: "/chat", state: { conciergeTopic: true } },
    );
    const original = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        init?.method === "POST" &&
        (url === "/api/concierge/chats" || url === "/api/chat/sessions")
      ) {
        posted.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ id: "topic-9", name: "New Chat", main: false, unread: 0 });
      }
      return original(input, init);
    }) as typeof fetch);
    // The topic chat's own empty state, not the home greeting or the main chat's.
    expect(await screen.findByRole("region", { name: "Start an ongoing topic" })).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Just tell me what you want to get done" }),
    ).toBeNull();
    const composer = await screen.findByRole("textbox");
    await waitFor(() => expect(document.activeElement).toBe(composer));
    expect(posted).toEqual([]);
    await userEvent.setup().keyboard("Plan my week{Enter}");
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith("topic-9"));
    // An untitled topic chat, which its first message names.
    expect(posted).toEqual([{ url: "/api/concierge/chats", body: {} }]);
    const turnPost = fetchSpy.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/chat/sessions/topic-9/turns" && init?.method === "POST",
    );
    expect((turnPost?.[1]?.body as FormData | undefined)?.get("text")).toBe("Plan my week");
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

  it("lands a missing Concierge chat on the main chat, so Agent mode stays", () => {
    seedChatListMode({ mode: "concierge", lastConcierge: "session-1" });
    renderChatComponent({ sessionId: "session-1" }, undefined, "/chat/session-1");

    fireEvent.click(screen.getByRole("button", { name: "Missing session" }));

    expect(screen.getByTestId("chat-location").textContent).toBe("/message REPLACE");
    expect(localStorage.getItem(LAST_CONCIERGE_KEY)).toBe("session-1");
  });

  it("keeps the chat open when another session is missing", () => {
    const onSessionNotFound = rs.fn();
    renderChatComponent(
      { sessionId: "session-1", onSessionNotFound },
      undefined,
      "/chat/session-1",
    );

    fireEvent.click(screen.getByRole("button", { name: "Missing other" }));

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

describe("ChatComponent Concierge", () => {
  const messageFetches = (spy: ReturnType<typeof renderChatComponent>["fetchSpy"]) =>
    spy.mock.calls.filter(([input]) =>
      String(input).includes("/api/chat/sessions/concierge/messages"),
    );

  it("loads the messages while the chat is still being created", async () => {
    let created!: () => void;
    const conciergeCreated = new Promise<void>((resolve) => {
      created = resolve;
    });
    const { fetchSpy } = renderChatComponent(
      { sessionId: "concierge" },
      { sessions: [], projects: [], conciergeCreated },
      "/chat/concierge",
    );

    await waitFor(() => expect(messageFetches(fetchSpy).length).toBeGreaterThan(0));
    expect(fetchSpy.mock.calls.some(([input]) => String(input) === "/api/concierge/session")).toBe(
      true,
    );
    created();
  });

  it("waits for the chat to be created and asks again when the first load finds none", async () => {
    let created!: () => void;
    const conciergeCreated = new Promise<void>((resolve) => {
      created = resolve;
    });
    const { fetchSpy } = renderChatComponent(
      { sessionId: "concierge" },
      { sessions: [], projects: [], conciergeCreated },
      "/chat/concierge",
    );
    await waitFor(() => expect(messageFetches(fetchSpy)).toHaveLength(1));

    await act(async () => created());

    await waitFor(() => expect(messageFetches(fetchSpy)).toHaveLength(2));
    expect(screen.getByTestId("chat-location").textContent).toBe("/chat/concierge POP");
  });

  it("shows the main chat its own empty state, not a topic chat's", async () => {
    renderChatComponent(
      { sessionId: "concierge" },
      { sessions: [], projects: [] },
      "/chat/concierge",
    );
    expect(
      await screen.findByRole("region", { name: "Just tell me what you want to get done" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Start an ongoing topic" })).toBeNull();
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
    expect(screen.getByTitle("App Store").getAttribute("src")).toBe(
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
