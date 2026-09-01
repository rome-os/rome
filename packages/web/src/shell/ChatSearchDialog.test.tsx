// @rstest-environment jsdom
import { fireEvent, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function mockSessionSearch(sessions: ChatSession[], contentMatches: ChatSearchMessageMatch[] = []) {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
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
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SearchHarness initialOpen={initialOpen} />
    </MemoryRouter>,
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
    const input = await screen.findByRole("combobox", { name: "Search chats" });
    expect(screen.getByRole("dialog", { name: "Search chats" })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(fetchSpy).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Search chats" })).toBeNull(),
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
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    await user.type(await screen.findByRole("combobox", { name: "Search chats" }), "roadmap");
    expect(await screen.findByRole("status", { name: "Searching messages…" })).toBeTruthy();
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

    const input = await screen.findByRole("combobox", { name: "Search chats" });
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

    const input = await screen.findByRole("combobox", { name: "Search chats" });
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

    const input = await screen.findByRole("combobox", { name: "Search chats" });
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

    await user.type(await screen.findByRole("combobox", { name: "Search chats" }), "missing");

    // The no-results state waits for the debounced message search to settle.
    expect(await screen.findByText("No chats found")).toBeTruthy();
    expect(screen.getByText("Try another chat title, project, or message text.")).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("keeps the listbox its combobox points at mounted with no results", async () => {
    // cmdk's input emits aria-controls unconditionally, so rendering the empty
    // state instead of the list would leave the combobox pointing at nothing.
    mockSessionSearch([chatSession("one", "Planning", "rome")]);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    const input = await screen.findByRole("combobox", { name: "Search chats" });
    await user.type(input, "missing");
    expect(await screen.findByText("No chats found")).toBeTruthy();

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

    const input = await screen.findByRole("combobox", { name: "Search chats" });
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

    await user.type(await screen.findByRole("combobox", { name: "Search chats" }), "roadmap");

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByText("1 result")).toBeTruthy();
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
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderSearch("/chat", true);

    expect(await screen.findByText("Chats couldn't be loaded")).toBeTruthy();
    const input = screen.getByRole("combobox", { name: "Search chats" });
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
