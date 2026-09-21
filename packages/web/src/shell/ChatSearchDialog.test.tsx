// @rstest-environment jsdom
import { fireEvent, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstalledAppCard } from "@rome/api-types/apps";
import { useState } from "react";
import { useLocation, MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import type { ChatSearchMessageMatch, ChatSession } from "@/lib/chat-types";
import { formatMessageTimestamp } from "@/lib/message-timestamp";
import {
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
    displayName,
    version: "1.0.0",
    description: "",
    status: "active",
    phase: "installed",
    hasFrontend: true,
    href: `/apps/${id}`,
    fullHref: `/full/apps/${id}`,
    capabilities: [],
    capabilityDetails: { agents: [], actions: [], skills: [], hooks: [] },
    isEnabled: true,
    canToggle: true,
    canUninstall: true,
    canPublish: false,
    accessMode: "private",
    isPublic: false,
    cloudAllowedEmails: [],
    canManagePublicAccess: false,
    source: { mode: "bundle", path: `/tmp/${id}` },
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
    if (url === "/api/apps") {
      return Response.json({ apps });
    }
    if (url === "/api/chat/sessions?status=all") {
      return Response.json(sessions);
    }
    if (url.startsWith("/api/chat/sessions/search?q=")) {
      return Response.json(contentMatches);
    }
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
    defaultOptions: { queries: { retry: false } },
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
    expect(fetchSpy).toHaveBeenCalled();

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
      if (url === "/api/apps") return Response.json({ apps: [] });
      if (url === "/api/chat/sessions?status=all") return Response.json([titled]);
      if (url.startsWith("/api/chat/sessions/search?q=")) return new Promise(() => {});
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
      screen.getByText("Try another app name or ID, chat title, project, or message text."),
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

  it("keeps apps out of the blank recent-chat view, then groups and ranks matches", async () => {
    mockSessionSearch(
      [chatSession("cal", "Calendar chat", "work")],
      [],
      [
        installedApp("tool-cal", "Utility", { origin: "appstore" }),
        installedApp("my-calendar", "My Calendar", { origin: "builtin" }),
        installedApp("calendar", "Calendar", { iconUrl: "/icons/calendar.png" }),
        installedApp("cal", "Cal"),
      ],
    );
    const user = userEvent.setup();
    renderSearch("/chat", true);

    expect(await screen.findAllByRole("option")).toHaveLength(1);
    expect(screen.queryByText("Utility")).toBeNull();

    await user.type(screen.getByRole("combobox", { name: "Search apps and chats" }), "cal");

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(5));
    expect(screen.getByText("Apps")).toBeTruthy();
    expect(screen.getByText("Chats")).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(options.slice(0, 4).map((option) => option.getAttribute("aria-label"))).toEqual([
      "Cal",
      "Calendar",
      "My Calendar",
      "Utility",
    ]);
    expect(options[4].textContent).toContain("Calendar chat");
    expect(options[1].querySelector("img")?.getAttribute("alt")).toBe("");
    expect(options.map((option) => option.getAttribute("data-value"))).toEqual([
      "app:cal",
      "app:calendar",
      "app:my-calendar",
      "app:tool-cal",
      "chat:cal",
    ]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/apps/cal"));
  });

  it("excludes apps that cannot be opened", async () => {
    mockSessionSearch(
      [],
      [],
      [
        installedApp("disabled", "Matching disabled", {
          status: "disabled",
          isEnabled: false,
        }),
        installedApp("failed", "Matching failed", { status: "failed", phase: "failed" }),
        installedApp("installing", "Matching installing", { phase: "installing" }),
        installedApp("backend-only", "Matching backend only", {
          hasFrontend: false,
          href: null,
          fullHref: null,
        }),
        installedApp("ready", "Matching ready"),
      ],
    );
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "matching",
    );

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].getAttribute("aria-label")).toBe("Matching ready");
  });

  it("opens a host-routed app in the current shell", async () => {
    mockSessionSearch(
      [],
      [],
      [
        installedApp("inbox", "Inbox", {
          hasFrontend: false,
          href: null,
          fullHref: null,
        }),
      ],
    );
    const user = userEvent.setup();
    renderSearch("/settings", true);

    await user.type(
      await screen.findByRole("combobox", { name: "Search apps and chats" }),
      "inbox",
    );
    await user.click(await screen.findByRole("option", { name: "Inbox" }));

    expect(screen.getByTestId("location").textContent).toBe("/apps/inbox");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps chat matches usable when apps fail and retries apps without clearing the query", async () => {
    let appCalls = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/apps") {
        appCalls += 1;
        if (appCalls === 1) return Response.json({}, { status: 500 });
        return Response.json({ apps: [installedApp("beta-app", "Beta app")] });
      }
      if (url === "/api/chat/sessions?status=all") {
        return Response.json([chatSession("beta-chat", "Beta chat", "work")]);
      }
      if (url.startsWith("/api/chat/sessions/search?q=")) return Response.json([]);
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    await user.type(input, "beta");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Apps couldn't be loaded");
    expect(screen.getByRole("option").textContent).toContain("Beta chat");

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect((input as HTMLInputElement).value).toBe("beta");
    expect(appCalls).toBe(2);
  });

  it("keeps app matches usable while chats fail", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/apps") {
        return Response.json({ apps: [installedApp("beta-app", "Beta app")] });
      }
      if (url === "/api/chat/sessions?status=all") throw new Error("offline");
      if (url.startsWith("/api/chat/sessions/search?q=")) return Response.json([]);
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    const input = await screen.findByRole("combobox", { name: "Search apps and chats" });
    await user.type(input, "beta");

    expect((await screen.findByRole("option")).textContent).toContain("Beta app");
    expect(screen.getByRole("alert").textContent).toContain("Chats couldn't be loaded");
    expect(screen.queryByText("No apps or chats found")).toBeNull();
  });

  it("keeps settled matches visible while the other source is loading", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/apps") return new Promise(() => {});
      if (url === "/api/chat/sessions?status=all") {
        return Response.json([chatSession("beta-chat", "Beta chat", "work")]);
      }
      if (url.startsWith("/api/chat/sessions/search?q=")) return Response.json([]);
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(await screen.findByRole("combobox", { name: "Search apps and chats" }), "beta");

    expect((await screen.findByRole("option")).textContent).toContain("Beta chat");
    expect(screen.getByText("1 result")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Searching apps and chats…" })).toBeTruthy();
    expect(screen.queryByText("No apps or chats found")).toBeNull();
  });

  it("retries a failed request without clearing the query", async () => {
    let sessionListCalls = 0;
    const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url === "/api/apps") return Response.json({ apps: [] });
      if (url === "/api/chat/sessions?status=all") {
        sessionListCalls += 1;
        if (sessionListCalls === 1) throw new Error("offline");
        return Response.json([chatSession("beta", "Beta plan", "work")]);
      }
      if (url.startsWith("/api/chat/sessions/search?q=")) {
        return Response.json([]);
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    expect(await screen.findByText("Chats couldn't be loaded")).toBeTruthy();
    const input = screen.getByRole("combobox", { name: "Search apps and chats" });
    await user.type(input, "beta");
    await user.click(screen.getByRole("button", { name: "Try again" }));

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
      if (url === "/api/apps") return Response.json({ apps: [] });
      if (url === "/api/chat/sessions?status=all") {
        sessionListCalls += 1;
        if (sessionListCalls === 1) throw new Error("offline");
        return Response.json([chatSession("beta", "Beta plan", "work")]);
      }
      if (url.startsWith("/api/chat/sessions/search?q=")) {
        return Response.json([]);
      }
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
