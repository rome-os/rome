// @rstest-environment jsdom
import { act, fireEvent, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation, MemoryRouter } from "react-router-dom";
import type { InstalledAppCard } from "@rome/api-types/apps";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { toast } from "sonner";
import i18n from "@/i18n";
import type { AgentCatalogGroup, ChatSearchMessageMatch, ChatSession } from "@/lib/chat-types";
import { formatMessageTimestamp } from "@/lib/message-timestamp";
import {
  agentMentionQuery,
  ChatSearchDialog,
  chatSearchShortcutForPlatform,
  isChatSearchShortcut,
  matchRanges,
} from "./ChatSearchDialog";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function chatSession(
  id: string,
  name: string,
  projectPath: string,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    name,
    personaId: null,
    projectName: projectPath.split("/").at(-1) ?? projectPath,
    projectPath,
    archivedAt: null,
    createdAt: "2026-07-14T08:00:00.000Z",
    activityAt: "2026-07-14T10:00:00.000Z",
    lastSeenActivityAt: null,
    unread: false,
    messageCount: 1,
    ...overrides,
  };
}

function installedApp(
  id: string,
  displayName: string,
  overrides: Partial<InstalledAppCard> = {},
): InstalledAppCard {
  return {
    id,
    version: "1.0.0",
    description: "",
    displayName,
    status: "active",
    phase: "installed",
    hasFrontend: true,
    href: `/apps/${encodeURIComponent(id)}`,
    fullHref: `/full/apps/${encodeURIComponent(id)}`,
    capabilities: [],
    capabilityDetails: { agents: [], actions: [], skills: [], hooks: [] },
    isEnabled: true,
    canToggle: true,
    canUninstall: true,
    canPublish: false,
    accessMode: "private",
    isPublic: false,
    cloudAllowedEmails: [],
    canManagePublicAccess: true,
    source: { mode: "bundle", path: `/tmp/${id}.tar.gz` },
    projectPath: null,
    origin: "local",
    iconUrl: null,
    ...overrides,
  };
}

function mockSessionSearch(
  sessions: ChatSession[],
  contentMatches: ChatSearchMessageMatch[] = [],
  apps: InstalledAppCard[] = [],
) {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/chat/sessions?status=all") {
      return Response.json(sessions);
    }
    if (url.startsWith("/api/chat/sessions/search?q=")) {
      return Response.json(contentMatches);
    }
    if (url === "/api/apps") return Response.json({ apps });
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
}

function SearchHarness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const location = useLocation();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open search
      </button>
      <ChatSearchDialog open={open} onOpenChange={setOpen} />
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
    </>
  );
}

function renderSearch(initialEntry = "/chat", initialOpen = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <SearchHarness initialOpen={initialOpen} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("chat search shortcut", () => {
  it("uses the platform-appropriate command key", () => {
    expect(chatSearchShortcutForPlatform("MacIntel")).toBe("⌘K");
    expect(chatSearchShortcutForPlatform("Win32")).toBe("Ctrl K");
    expect(
      isChatSearchShortcut(
        { key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isChatSearchShortcut(
        { key: "K", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
        "Win32",
      ),
    ).toBe(true);
    expect(
      isChatSearchShortcut(
        { key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "Win32",
      ),
    ).toBe(false);
  });

  it("opens and closes the dialog with Ctrl+K", async () => {
    const fetchSpy = mockSessionSearch([]);
    renderSearch();
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    expect(screen.getByRole("dialog", { name: "Search apps and chats" })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledWith("/api/apps", expect.any(Object));

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Search apps and chats" })).toBeNull(),
    );
  });
});

describe("matchRanges", () => {
  it("maps accent-folded matches back to original string offsets", () => {
    expect(matchRanges("Launch résumé", ["resume"])).toEqual([{ start: 7, end: 13 }]);
    expect(matchRanges("Roadmap review", ["road"])).toEqual([{ start: 0, end: 4 }]);
    expect(matchRanges("Roadmap review", ["missing"])).toEqual([]);
    expect(matchRanges("", ["road"])).toEqual([]);
    expect(matchRanges("Roadmap", [])).toEqual([]);
  });

  it("merges overlapping and adjacent term ranges", () => {
    expect(matchRanges("alpha beta", ["alpha", "pha be"])).toEqual([{ start: 0, end: 8 }]);
    expect(matchRanges("one two one", ["one"])).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });
});

describe("ChatSearchDialog", () => {
  it("names the loading status while chats are fetched", () => {
    rs.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));

    renderSearch("/chat", true);

    expect(screen.getByRole("status", { name: "Loading chats…" })).toBeTruthy();
  });

  it("exposes one live status while message results are loading", async () => {
    const titled = chatSession("titled", "Roadmap review", "work/rome");
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/sessions?status=all") return Response.json([titled]);
      if (url.startsWith("/api/chat/sessions/search?q=")) return new Promise(() => {});
      if (url === "/api/apps") return Response.json({ apps: [] });
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "roadmap",
    );
    expect(await screen.findByRole("status", { name: "Searching apps and chats…" })).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("searches titles and project paths across active and archived chats", async () => {
    const fetchSpy = mockSessionSearch([
      chatSession("current", "Roadmap review", "work/rome", {
        activityAt: "2026-07-15T10:00:00.000Z",
      }),
      chatSession("archived", "Launch résumé", "clients/acme", {
        archivedAt: "2026-07-15T09:00:00.000Z",
      }),
    ]);
    const user = userEvent.setup();

    renderSearch("/chat/current", true);

    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    expect(fetchSpy).toHaveBeenCalledWith("/api/chat/sessions?status=all", {
      credentials: "include",
    });
    expect(screen.getByText("Current")).toBeTruthy();

    await user.type(input, "clients acme");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(within(options[0]).getByText("Launch résumé")).toBeTruthy();
    expect(within(options[0]).getByText("Archived")).toBeTruthy();
    expect(screen.getByText("1 result")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("Recent chats")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(2);

    await user.type(input, "resume");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    const option = screen.getAllByRole("option")[0];
    expect(option.textContent).toContain("Launch résumé");
    const marks = Array.from(option.querySelectorAll("mark")).map((mark) => mark.textContent);
    expect(marks).toEqual(["résumé"]);
  });

  it("highlights every matched term and shows the chat's activity time", async () => {
    mockSessionSearch([
      chatSession("archived", "Launch résumé", "clients/acme", {
        activityAt: "2026-07-15T09:00:00.000Z",
      }),
    ]);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    const option = (await screen.findAllByRole("option"))[0];
    expect(
      within(option).getByText(formatMessageTimestamp("2026-07-15T09:00:00.000Z")),
    ).toBeTruthy();
    expect(option.querySelector("mark")).toBeNull();

    await user.type(input, "clients acme");
    const marks = Array.from(
      screen.getAllByRole("option")[0].querySelectorAll("mark"),
      (mark) => mark.textContent,
    );
    expect(marks).toEqual(["clients", "acme"]);
  });

  it("moves through results with arrows and opens the selected chat", async () => {
    mockSessionSearch([
      chatSession("first", "First chat", "alpha", {
        activityAt: "2026-07-15T11:00:00.000Z",
      }),
      chatSession("second", "Second chat", "beta", {
        activityAt: "2026-07-15T10:00:00.000Z",
      }),
    ]);
    renderSearch("/settings?hideSidebar=1", true);

    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    const options = await screen.findAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/chat/second?hideSidebar=1"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a focused no-results state", async () => {
    mockSessionSearch([chatSession("one", "Planning", "rome")]);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "missing",
    );

    // The no-results state waits for the debounced message search to settle.
    expect(await screen.findByText("No apps or chats found")).toBeTruthy();
    expect(
      screen.getByText("Try another app name, app id, chat title, project, or message text."),
    ).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("keeps the listbox its combobox points at mounted with no results", async () => {
    // cmdk's input emits aria-controls unconditionally, so rendering the empty
    // state instead of the list would leave the combobox pointing at nothing.
    mockSessionSearch([chatSession("one", "Planning", "rome")]);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    await user.type(input, "missing");
    expect(await screen.findByText("No apps or chats found")).toBeTruthy();

    const controls = input.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls as string)).not.toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("surfaces message-content matches with role-labelled snippets", async () => {
    const titled = chatSession("titled", "Roadmap review", "work/rome");
    const contentOnly = chatSession("content-only", "Random notes", "work/rome");
    mockSessionSearch(
      [titled, contentOnly],
      [
        {
          session: contentOnly,
          message: {
            id: "m1",
            role: "assistant",
            snippet: "…the roadmap milestones are locked…",
            createdAt: "2026-07-14T10:00:00.000Z",
          },
        },
      ],
    );
    const user = userEvent.setup();
    renderSearch("/chat", true);

    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    await user.type(input, "roadmap");

    // Title match shows immediately; the content match lands after the debounce.
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(screen.getByText("2 results")).toBeTruthy();

    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("Roadmap review");
    expect(options[1].textContent).toContain("Random notes");
    expect(options[1].textContent).toContain("Assistant:");
    const snippetMarks = Array.from(
      options[1].querySelectorAll("mark"),
      (mark) => mark.textContent,
    );
    expect(snippetMarks).toContain("roadmap");
  });

  it("renders one row per session when the search returns repeat matches", async () => {
    // The endpoint documents one match per session; if it ever returns two,
    // the row must not be duplicated — that would collide on both the React
    // key and the cmdk option value.
    const contentOnly = chatSession("content-only", "Random notes", "work/rome");
    const message = (id: string, snippet: string) => ({
      id,
      role: "assistant" as const,
      snippet,
      createdAt: "2026-07-14T10:00:00.000Z",
    });
    mockSessionSearch(
      [contentOnly],
      [
        { session: contentOnly, message: message("m1", "…first roadmap mention…") },
        { session: contentOnly, message: message("m2", "…second roadmap mention…") },
      ],
    );
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "roadmap",
    );

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByText("1 result")).toBeTruthy();
  });

  it("keeps apps out of the blank state, then groups them before matching chats", async () => {
    mockSessionSearch(
      [chatSession("road-chat", "Roadmap review", "work/rome")],
      [],
      [installedApp("road-app", "Roadmap")],
    );
    const user = userEvent.setup();
    renderSearch("/settings", true);

    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    const recentOptions = await screen.findAllByRole("option");
    expect(recentOptions).toHaveLength(1);
    expect(recentOptions[0].textContent).toContain("Roadmap review");
    expect(screen.queryByRole("option", { name: "Roadmap" })).toBeNull();

    await user.type(input, "road");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0].getAttribute("aria-label")).toBe("Roadmap");
    expect(options[1].textContent).toContain("Roadmap review");
    expect(screen.getByText("Apps")).toBeTruthy();
    expect(screen.getByText("Chats")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/apps/road-app"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ranks openable app matches and excludes apps that cannot be opened", async () => {
    mockSessionSearch(
      [],
      [],
      [
        installedApp("exact", "Notes", { origin: "builtin", iconUrl: "/notes.svg" }),
        installedApp("prefix", "Notes Hub", { origin: "appstore" }),
        installedApp("contains", "My Notes"),
        installedApp("notes-tool", "Writer"),
        installedApp("disabled", "Notes Disabled", {
          status: "disabled",
          isEnabled: false,
        }),
        installedApp("failed", "Notes Failed", { status: "failed" }),
        installedApp("installing", "Notes Installing", { phase: "installing" }),
        installedApp("backend", "Notes Backend", {
          hasFrontend: false,
          href: null,
          fullHref: null,
        }),
      ],
    );
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "notes",
    );
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
      "Notes",
      "Notes Hub",
      "My Notes",
      "Writer",
    ]);
    const icon = options[0].querySelector("img");
    expect(icon?.getAttribute("src")).toBe("/notes.svg");
    expect(icon?.getAttribute("alt")).toBe("");
    expect(options[1].textContent).toContain("N");
  });

  it("opens a registered host-owned app route", async () => {
    mockSessionSearch(
      [],
      [],
      [installedApp("inbox", "Inbox", { hasFrontend: false, href: null, fullHref: null })],
    );
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "inbox",
    );
    await user.click(await screen.findByRole("option", { name: "Inbox" }));
    expect(screen.getByTestId("location").textContent).toBe("/apps/inbox");
  });

  it("preserves hidden-sidebar mode alongside an app's existing query string", async () => {
    mockSessionSearch(
      [],
      [],
      [installedApp("road", "Roadmap", { href: "/apps/road?view=compact" })],
    );
    const user = userEvent.setup();
    renderSearch("/settings?hideSidebar=1", true);

    await user.type(await screen.findByRole("combobox", { name: "Search apps and chats" }), "road");
    await user.click(await screen.findByRole("option", { name: "Roadmap" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/apps/road?view=compact&hideSidebar=1",
    );
  });

  it("keeps app matches usable when chats fail", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/sessions?status=all") throw new Error("chat offline");
      if (url.startsWith("/api/chat/sessions/search?q=")) return Response.json([]);
      if (url === "/api/apps") return Response.json({ apps: [installedApp("road", "Roadmap")] });
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    expect(await screen.findByText("Chats couldn't be loaded")).toBeTruthy();
    const input = screen.getByRole("combobox", { name: "Search apps and chats" });
    await user.type(input, "road");
    expect(await screen.findByRole("option", { name: "Roadmap" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry loading chats" })).toBeTruthy();
  });

  it("keeps chat matches usable while apps load", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/sessions?status=all") {
        return Response.json([chatSession("road", "Roadmap review", "work/rome")]);
      }
      if (url.startsWith("/api/chat/sessions/search?q=")) return Response.json([]);
      if (url === "/api/apps") return new Promise(() => {});
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(await screen.findByRole("combobox", { name: "Search apps and chats" }), "road");
    expect((await screen.findAllByRole("option"))[0].textContent).toContain("Roadmap review");
    expect(screen.getByRole("status", { name: "Searching apps and chats…" })).toBeTruthy();
    expect(screen.queryByText("No apps or chats found")).toBeNull();
  });

  it("retries an app failure without clearing the query or hiding chat matches", async () => {
    let appCalls = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/sessions?status=all") {
        return Response.json([chatSession("beta-chat", "Beta plan", "work")]);
      }
      if (url.startsWith("/api/chat/sessions/search?q=")) return Response.json([]);
      if (url === "/api/apps") {
        appCalls += 1;
        if (appCalls === 1) throw new Error("app offline");
        return Response.json({ apps: [installedApp("beta-app", "Beta App")] });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    await user.type(input, "beta");
    expect((await screen.findAllByRole("option"))[0].textContent).toContain("Beta plan");
    await user.click(await screen.findByRole("button", { name: "Retry loading apps" }));

    expect(await screen.findByRole("option", { name: "Beta App" })).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("beta");
    expect(appCalls).toBe(2);
  });

  it("retries a failed request without clearing the query", async () => {
    let sessionListCalls = 0;
    const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url === "/api/chat/sessions?status=all") {
        sessionListCalls += 1;
        if (sessionListCalls === 1) throw new Error("offline");
        return Response.json([chatSession("beta", "Beta plan", "work")]);
      }
      if (url.startsWith("/api/chat/sessions/search?q=")) {
        return Response.json([]);
      }
      if (url === "/api/apps") return Response.json({ apps: [] });
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    expect(await screen.findByText("Chats couldn't be loaded")).toBeTruthy();
    const input = screen.getByRole("combobox", { name: "Search apps and chats" });
    await user.type(input, "beta");
    await user.click(screen.getByRole("button", { name: "Retry loading chats" }));

    const [retried] = await screen.findAllByRole("option");
    expect(retried.textContent).toContain("Beta plan");
    expect((input as HTMLInputElement).value).toBe("beta");
    expect(fetchSpy).toHaveBeenCalled();
    expect(sessionListCalls).toBe(2);
  });

  it("retries from the keyboard when Try again has focus", async () => {
    // The retry button sits inside <Command>, whose root cancels Enter's
    // native action to drive list selection. Enter must still reach the
    // button rather than being swallowed by the command root.
    let sessionListCalls = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/sessions?status=all") {
        sessionListCalls += 1;
        if (sessionListCalls === 1) throw new Error("offline");
        return Response.json([chatSession("beta", "Beta plan", "work")]);
      }
      if (url.startsWith("/api/chat/sessions/search?q=")) {
        return Response.json([]);
      }
      if (url === "/api/apps") return Response.json({ apps: [] });
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    expect(await screen.findByText("Chats couldn't be loaded")).toBeTruthy();
    screen.getByRole("button", { name: "Try again" }).focus();
    await user.keyboard("{Enter}");

    const [retried] = await screen.findAllByRole("option");
    expect(retried.textContent).toContain("Beta plan");
    expect(sessionListCalls).toBe(2);
  });
});

const AGENT_CATALOG: AgentCatalogGroup[] = [
  {
    ownerId: "core",
    ownerType: "core",
    label: "Rome",
    description: "",
    iconUrl: null,
    agents: [{ name: "main", localName: "main", description: "The main agent" }],
  },
  {
    ownerId: "research",
    ownerType: "app",
    label: "Research",
    description: "",
    iconUrl: null,
    agents: [
      { name: "research:explorer", localName: "explorer", description: "Explores sources" },
      { name: "research:writer", localName: "writer", description: "Writes reports" },
    ],
  },
];

interface AgentFetchOptions {
  turnResponses?: Array<Response | Promise<Response>>;
  agentResponses?: Response[];
}

function mockAgentMessaging({ turnResponses = [], agentResponses = [] }: AgentFetchOptions = {}) {
  const pendingTurns = [...turnResponses];
  const pendingAgents = [...agentResponses];
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const spy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body =
        init?.body instanceof FormData
          ? Object.fromEntries(init.body.entries())
          : JSON.parse(String(init?.body ?? "{}"));
      requests.push({ url, method, body });
    }
    if (url === "/api/chat/sessions?status=all") return Response.json([]);
    if (url.startsWith("/api/chat/sessions/search?q=")) return Response.json([]);
    if (url === "/api/apps") return Response.json({ apps: [] });
    if (url === "/api/chat/agents") return pendingAgents.shift() ?? Response.json(AGENT_CATALOG);
    if (url === "/api/chat/sessions" && method === "POST") {
      return Response.json(chatSession("new-chat", "New Chat", "default"));
    }
    if (url === "/api/chat/sessions/new-chat/turns" && method === "POST") {
      return pendingTurns.shift() ?? Response.json({ turnId: "turn-1", status: "running" });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
  return { spy, requests };
}

describe("agentMentionQuery", () => {
  it("reads a lone leading @ token as an agent filter", () => {
    expect(agentMentionQuery("@")).toBe("");
    expect(agentMentionQuery("@expl")).toBe("expl");
    expect(agentMentionQuery("  @research/writer")).toBe("research/writer");
  });

  it("leaves any other query to search", () => {
    expect(agentMentionQuery("")).toBeNull();
    expect(agentMentionQuery("@expl hello")).toBeNull();
    expect(agentMentionQuery("mail me@example.com")).toBeNull();
  });
});

describe("ChatSearchDialog agent messaging", () => {
  it("offers matching agents after @ without searching chats", async () => {
    const { spy } = mockAgentMessaging();
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "@expl",
    );

    const list = await screen.findByRole("listbox", { name: "Agents" });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(["ExplorerExplores sources"]),
    );
    expect(spy.mock.calls.some(([input]) => String(input).includes("/sessions/search"))).toBe(
      false,
    );
  });

  it("pins the picked agent, then starts a new chat with the typed message on Enter", async () => {
    const { requests } = mockAgentMessaging();
    const user = userEvent.setup();
    renderSearch("/chat?hideSidebar=1", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "@writ",
    );
    await screen.findByRole("option", { name: "Writer" });
    await user.keyboard("{Enter}");

    const input = await screen.findByRole("combobox", { name: "Message Writer" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Writer", { selector: "span" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Writer" })).toBeTruthy();

    await user.type(input, "Draft the Q3 summary");
    expect(
      await screen.findByRole("option", { name: /Start a new chat with Writer/ }),
    ).toBeTruthy();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/chat/new-chat?hideSidebar=1"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: "/api/chat/sessions",
      body: { name: "New Chat", projectPath: "default", agentName: "research:writer" },
    });
    expect(requests[1]).toMatchObject({
      url: "/api/chat/sessions/new-chat/turns",
      body: { text: "Draft the Q3 summary" },
    });
  });

  it("sends nothing until the pinned agent has a message", async () => {
    const { requests } = mockAgentMessaging();
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(await screen.findByRole("combobox", { name: "Search apps and chats" }), "@");
    await user.click(await screen.findByRole("option", { name: "Main" }));
    const input = await screen.findByRole("combobox", { name: "Message Main" });
    expect(
      screen.getByText("Type a message, then press Enter to start a new chat with Main."),
    ).toBeTruthy();

    await user.type(input, "   {Enter}");
    expect(requests).toHaveLength(0);
    expect(screen.getByTestId("location").textContent).toBe("/chat");
  });

  it("unpins the agent on Backspace in an empty field", async () => {
    mockAgentMessaging();
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "@expl",
    );
    await user.click(await screen.findByRole("option", { name: "Explorer" }));
    const input = await screen.findByRole("combobox", { name: "Message Explorer" });

    await user.type(input, "{Backspace}");

    expect(await screen.findByRole("combobox", { name: "Search apps and chats" })).toBe(input);
    expect(screen.queryByRole("button", { name: "Remove Explorer" })).toBeNull();
  });

  it("keeps the draft after a failed send and retries into the same chat", async () => {
    const { requests } = mockAgentMessaging({
      turnResponses: [Response.json({ error: "Agent is busy" }, { status: 503 })],
    });
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "@expl",
    );
    await user.click(await screen.findByRole("option", { name: "Explorer" }));
    const input = await screen.findByRole("combobox", { name: "Message Explorer" });
    await user.type(input, "Find sources{Enter}");

    expect((await screen.findByRole("alert")).textContent).toContain("Agent is busy");
    expect((input as HTMLInputElement).value).toBe("Find sources");
    expect(screen.getByTestId("location").textContent).toBe("/chat");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/new-chat"));

    const sessionCreates = requests.filter((request) => request.url === "/api/chat/sessions");
    const turns = requests.filter((request) => request.url.endsWith("/turns"));
    expect(sessionCreates).toHaveLength(1);
    expect(turns).toHaveLength(2);
    // Same inputId, so a turn the server had accepted is not recorded twice.
    expect((turns[0].body as { inputId: string }).inputId).toBe(
      (turns[1].body as { inputId: string }).inputId,
    );
  });
});

describe("ChatSearchDialog agent message controls", () => {
  it("clears a failed send's error along with the text", async () => {
    mockAgentMessaging({
      turnResponses: [Response.json({ error: "Agent is busy" }, { status: 503 })],
    });
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "@expl",
    );
    await user.click(await screen.findByRole("option", { name: "Explorer" }));
    await user.type(
      await screen.findByRole("combobox", { name: "Message Explorer" }),
      "Find sources{Enter}",
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Agent is busy");

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (screen.getByRole("combobox", { name: "Message Explorer" }) as HTMLInputElement).value,
    ).toBe("");
  });

  it("offers no chip remove control while a send is in flight", async () => {
    let finishTurn: (response: Response) => void = () => {};
    mockAgentMessaging({
      turnResponses: [
        new Promise<Response>((resolve) => {
          finishTurn = resolve;
        }),
      ],
    });
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "@expl",
    );
    await user.click(await screen.findByRole("option", { name: "Explorer" }));
    await user.type(
      await screen.findByRole("combobox", { name: "Message Explorer" }),
      "Find sources{Enter}",
    );

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove Explorer" })).toBeNull(),
    );

    finishTurn(Response.json({ error: "Agent is busy" }, { status: 503 }));
    expect(await screen.findByRole("button", { name: "Remove Explorer" })).toBeTruthy();
  });
});

describe("ChatSearchDialog agent messaging across openings", () => {
  it("offers Retry when the agent catalog fails with a server error", async () => {
    mockAgentMessaging({
      agentResponses: [Response.json({ error: "boom" }, { status: 500 })],
    });
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(await screen.findByRole("combobox", { name: "Search apps and chats" }), "@");

    expect((await screen.findByRole("alert")).textContent).toContain("Agents couldn't be loaded");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("option", { name: "Explorer" })).toBeTruthy();
  });

  it("confirms a send that succeeds after the dialog closed, with a way to open the chat", async () => {
    let finishTurn: (response: Response) => void = () => {};
    const { requests } = mockAgentMessaging({
      turnResponses: [
        new Promise<Response>((resolve) => {
          finishTurn = resolve;
        }),
      ],
    });
    const toastSuccess = rs.spyOn(toast, "success").mockImplementation(() => "toast-id");
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "@expl",
    );
    await user.click(await screen.findByRole("option", { name: "Explorer" }));
    await user.type(
      await screen.findByRole("combobox", { name: "Message Explorer" }),
      "Find sources{Enter}",
    );
    await waitFor(() => expect(requests.some((r) => r.url.endsWith("/turns"))).toBe(true));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    finishTurn(Response.json({ turnId: "turn-1", status: "running" }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    const [title, options] = toastSuccess.mock.calls[0] as [
      string,
      { description: string; action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe("Message sent to Explorer");
    expect(options.description).toBe("Find sources");
    expect(options.action.label).toBe("Open");
    // Closing the dialog is not a request to navigate; only the action opens it.
    expect(screen.getByTestId("location").textContent).toBe("/chat");

    act(() => options.action.onClick());
    expect(screen.getByTestId("location").textContent).toBe("/chat/new-chat");
  });

  it("reports a send that fails after the dialog closed, and leaves the next opening unblocked", async () => {
    let failTurn: (response: Response) => void = () => {};
    const { requests } = mockAgentMessaging({
      turnResponses: [
        new Promise<Response>((resolve) => {
          failTurn = resolve;
        }),
      ],
    });
    const toastError = rs.spyOn(toast, "error").mockImplementation(() => "toast-id");
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "@expl",
    );
    await user.click(await screen.findByRole("option", { name: "Explorer" }));
    await user.type(
      await screen.findByRole("combobox", { name: "Message Explorer" }),
      "Find sources{Enter}",
    );
    await waitFor(() => expect(requests.some((r) => r.url.endsWith("/turns"))).toBe(true));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    failTurn(Response.json({ error: "Agent is busy" }, { status: 503 }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Your message to Explorer wasn't sent: Agent is busy",
        {
          description: "Find sources",
        },
      ),
    );
    expect(screen.getByTestId("location").textContent).toBe("/chat");

    // The next opening sends a fresh chat instead of inheriting the stale
    // send's in-flight guard or its session.
    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "@writ",
    );
    await user.click(await screen.findByRole("option", { name: "Writer" }));
    await user.type(
      await screen.findByRole("combobox", { name: "Message Writer" }),
      "Draft it{Enter}",
    );
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/new-chat"));
    expect(requests.filter((r) => r.url === "/api/chat/sessions")).toHaveLength(2);
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});

describe("ChatSearchDialog agent catalog errors", () => {
  // Records all text React writes into the document, including text a later
  // render in the same act() replaces before an assertion could see it. React
  // reuses the panel's nodes across states, so an old error shows up as
  // rewritten text rather than as a new `role="alert"` element.
  function writtenText(): { stop: () => string[] } {
    const seen: string[] = [];
    const collect = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type === "characterData") seen.push(record.target.textContent ?? "");
        for (const node of record.addedNodes) seen.push(node.textContent ?? "");
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    return {
      stop: () => {
        collect(observer.takeRecords());
        observer.disconnect();
        return seen;
      },
    };
  }

  it("does not render an old load error when @ is deleted and typed again", async () => {
    mockAgentMessaging({
      agentResponses: [Response.json({ error: "boom" }, { status: 500 })],
    });
    const user = userEvent.setup();
    renderSearch("/chat", true);

    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    await user.type(input, "@");
    expect((await screen.findByRole("alert")).textContent).toContain("Agents couldn't be loaded");

    const watch = writtenText();
    await user.type(input, "{Backspace}@");

    expect(await screen.findByRole("option", { name: "Explorer" })).toBeTruthy();
    const written = watch.stop();
    expect(written.filter((text) => text.includes("Agents couldn't be loaded"))).toEqual([]);
    expect(written.some((text) => text.includes("Loading agents…"))).toBe(true);
  });
});
