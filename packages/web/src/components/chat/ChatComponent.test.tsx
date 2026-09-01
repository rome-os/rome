// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { ChatComponent, type ChatComponentProps } from "./ChatComponent";

rs.mock("@/components/logo", () => ({
  RomeLogo: (props: Record<string, unknown>) => <div data-testid="rome-logo" {...props} />,
}));

rs.mock("./Chat", () => ({
  Chat: ({ mainAgentDisplayName }: { mainAgentDisplayName?: string }) => (
    <div data-testid="session-chat">{mainAgentDisplayName}</div>
  ),
}));

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
  localStorage.clear();
  rs.restoreAllMocks();
  await i18n.changeLanguage("en");
});

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

function renderChatComponent(
  props: Partial<ChatComponentProps> = {},
  homeData?: {
    sessions: Array<Record<string, unknown>>;
    projects: Array<Record<string, unknown>>;
    newsFeed?: unknown;
  },
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
    if (url === "/api/chat/sessions") {
      return Response.json(homeData?.sessions ?? []);
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
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ChatComponent onSessionCreated={() => {}} {...props} />
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
  it("passes the onboarding agent name from settings into an existing chat", async () => {
    renderChatComponent({ sessionId: "session-1" });

    await waitFor(() => expect(screen.getByTestId("session-chat").textContent).toBe("Atlas"));
  });
});

describe("ChatComponent empty home", () => {
  it("shows horizontally scrollable pinned chats and Rome News above a bottom composer", async () => {
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

    const greeting = await screen.findByText("Hi Ada,");
    expect(greeting.previousElementSibling?.getAttribute("data-testid")).toBe("rome-logo");
    expect(greeting.classList.contains("text-display")).toBe(true);
    expect(greeting.className).not.toMatch(/(?:^|\s)(?:text-2xl|font-light|leading-tight)(?:\s|$)/);
    expect(greeting.className).not.toContain("md:text-[1.75rem]");
    const hero = greeting.nextElementSibling;
    expect(hero?.className).toBe(
      "rome-empty-rise mt-1 font-serif text-[2.65rem] font-normal leading-[1.05] tracking-[-0.025em] text-foreground md:text-[3.35rem]",
    );
    expect(await screen.findByText("Pinned planning chat")).toBeTruthy();
    expect(screen.getByText("Pinned launch chat")).toBeTruthy();
    expect(screen.queryByText("Pinned projects")).toBeNull();
    expect(screen.queryByText("Alpha project")).toBeNull();
    expect(screen.getByText("Rome News")).toBeTruthy();

    const pinnedRail = document.querySelector('[data-horizontal-scroll="pinned-chats"]');
    const newsRail = document.querySelector('[data-horizontal-scroll="rome-news"]');
    expect(pinnedRail?.classList.contains("overflow-x-auto")).toBe(true);
    expect(pinnedRail?.className).toContain("scrollbar-width:none");
    // The WebKit scrollbar hides via display, not a zero-height box: the box
    // size scale (docs/ui/primitive-token/box-size-primitives.md) has no zero.
    expect(pinnedRail?.className).toContain("scrollbar]:hidden");
    expect(pinnedRail?.className).not.toContain("scrollbar]:h-0");
    expect(pinnedRail?.className).not.toContain("snap-");
    expect(pinnedRail?.parentElement?.classList.contains("overflow-visible")).toBe(true);
    expect(pinnedRail?.children).toHaveLength(2);
    expect(newsRail?.classList.contains("overflow-x-auto")).toBe(true);
    expect(newsRail?.className).toContain("scrollbar-width:none");
    expect(newsRail?.className).toContain("scrollbar]:hidden");
    expect(newsRail?.className).not.toContain("scrollbar]:h-0");
    expect(newsRail?.parentElement?.classList.contains("overflow-visible")).toBe(true);
    expect(newsRail?.firstElementChild?.className).toContain("w-[min(58.5vw,13.5rem)]");
    expect(newsRail?.firstElementChild?.className).toContain("sm:w-[13.5rem]");
    const pinnedHeading = screen.getByRole("heading", { name: "Pinned chats" });
    const newsHeading = screen.getByRole("heading", { name: "Rome News" });
    expect(pinnedHeading.classList.contains("text-aux")).toBe(true);
    expect(newsHeading.classList.contains("text-aux")).toBe(true);
    expect(pinnedHeading.className).not.toMatch(/(?:^|\s)(?:text-sm|font-semibold)(?:\s|$)/);
    expect(newsHeading.className).not.toMatch(/(?:^|\s)(?:text-sm|font-semibold)(?:\s|$)/);
    const pinnedTitle = screen.getByText("Pinned planning chat");
    expect(pinnedTitle.classList.contains("text-ui")).toBe(true);
    expect(pinnedTitle.className).not.toMatch(/(?:^|\s)(?:text-sm|font-medium)(?:\s|$)/);
    expect(screen.getByText("alpha").classList.contains("text-aux")).toBe(true);
    expect(pinnedHeading.nextElementSibling?.classList.contains("text-aux")).toBe(true);
    expect(screen.getByRole("button", { name: "Cloud announcement" }).className).toContain(
      "[&_.rome-news-item-subtitle]:!text-body",
    );
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

    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton.closest(".sticky")).toBeTruthy();

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

  it("hides Rome News when Rome Cloud publishes an empty feed", async () => {
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

  it("does not carry a bundled Rome News fallback when Rome Cloud is unavailable", async () => {
    const { fetchSpy } = renderChatComponent({}, { sessions: [], projects: [] });

    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([input]) => String(input).endsWith("/api/rome-news"))).toBe(
        true,
      ),
    );
    expect(screen.queryByRole("heading", { name: "Rome News" })).toBeNull();
  });

  it("executes chat, App Store, and link actions from Cloud definitions", async () => {
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
