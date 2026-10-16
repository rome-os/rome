// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import i18n from "@/i18n";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import type { LiveEventsClient } from "@/lib/live-events";
import {
  acceptLatestSocket,
  FakeWebSocket,
  fakeSocketLiveEventsClient,
} from "@/test/fake-websocket";
import { RecentChats } from "./RecentChats";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.useRealTimers();
  localStorage.clear();
  rs.restoreAllMocks();
});

interface MockSession {
  id: string;
  name: string;
  createdAt: string;
  activityAt: string;
  lastSeenActivityAt: string | null;
  unread: boolean;
  running?: boolean;
  lastTurnFailed?: boolean;
  projectName: string;
  projectPath: string;
  archivedAt?: string | null;
  pinnedAt?: string | null;
}

function mockSessions(sessions: MockSession[]) {
  const spy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/chat/sessions") && method === "GET") {
      const status = new URL(url, "http://localhost").searchParams.get("status") ?? "active";
      const filtered = sessions.filter((s) => {
        if (status === "all") return true;
        if (status === "archived") return Boolean(s.archivedAt);
        return !s.archivedAt;
      });
      return new Response(JSON.stringify(filtered), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/api\/chat\/sessions\/[^/]+\/archive$/.test(url) && method === "PATCH") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/api\/chat\/sessions\/[^/]+\/pin$/.test(url) && method === "PATCH") {
      const id = url.match(/\/api\/chat\/sessions\/([^/]+)\/pin$/)?.[1];
      const body = JSON.parse(String(init?.body ?? "{}")) as { pinned?: boolean };
      const target = sessions.find((s) => s.id === id);
      if (target) target.pinnedAt = body.pinned ? new Date().toISOString() : null;
      return new Response(JSON.stringify(target ?? { ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/api\/chat\/sessions\/[^/]+\/name$/.test(url) && method === "PATCH") {
      const id = url.match(/\/api\/chat\/sessions\/([^/]+)\/name$/)?.[1];
      const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
      const target = sessions.find((s) => s.id === id);
      if (target && typeof body.name === "string") target.name = body.name;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/api\/chat\/sessions\/[^/]+$/.test(url) && method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch);
  return spy;
}

function renderRecentChats(initialEntry = "/chat", onSearch = () => {}, live?: LiveEventsClient) {
  const routed = (
    <MemoryRouter initialEntries={[initialEntry]}>
      <RecentChats onSearch={onSearch} />
      <LocationProbe />
    </MemoryRouter>
  );
  return render(
    live ? (
      <LiveEventsClientContext.Provider value={live}>{routed}</LiveEventsClientContext.Provider>
    ) : (
      routed
    ),
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-path">{location.pathname}</output>;
}

function textIndex(container: HTMLElement, text: string): number {
  return container.textContent?.indexOf(text) ?? -1;
}

describe("RecentChats", () => {
  it("defaults to All chats and persists a scope toggle across remounts", async () => {
    const fetchSpy = mockSessions([]);
    const user = userEvent.setup();
    const view = renderRecentChats();
    const requestedScope = () =>
      new URL(String(fetchSpy.mock.calls.at(-1)?.[0]), "http://localhost").searchParams.get(
        "scope",
      );
    await waitFor(() => expect(requestedScope()).toBe("all"));
    await user.click(screen.getByRole("button", { name: "List settings" }));
    const all = screen.getByRole("menuitem", { name: "All chats" });
    expect(all.querySelector("svg")).not.toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "My chats" }));
    await waitFor(() => expect(requestedScope()).toBe("mine"));
    expect(localStorage.getItem("rome-recent-chats-scope")).toBe("mine");
    view.unmount();
    const remounted = renderRecentChats();
    await waitFor(() => expect(requestedScope()).toBe("mine"));
    await user.click(screen.getByRole("button", { name: "List settings" }));
    expect(screen.getByRole("menuitem", { name: "My chats" }).querySelector("svg")).not.toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "All chats" }));
    await waitFor(() => expect(requestedScope()).toBe("all"));
    expect(localStorage.getItem("rome-recent-chats-scope")).toBe("all");
    remounted.unmount();
  });

  it.each([
    ["My chats", 200],
    ["My chats", 500],
    ["Archived", 200],
    ["Archived", 500],
  ])("ignores a stale %s list response with status %s", async (selection, status) => {
    let respond!: (response: Response) => void;
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      )
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const user = userEvent.setup();
    renderRecentChats();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "List settings" }));
    await user.click(screen.getByRole("menuitem", { name: selection }));
    await screen.findByText("No chats yet");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      respond(
        new Response(
          JSON.stringify([
            {
              id: "stale",
              name: "Stale chat",
              createdAt: "2026-07-01T00:00:00.000Z",
              activityAt: "2026-07-01T00:00:00.000Z",
              lastSeenActivityAt: null,
              unread: false,
              projectName: "alpha",
              projectPath: "alpha",
            },
          ]),
          { status },
        ),
      );
    });
    expect(screen.queryByText("Stale chat")).toBeNull();
    expect(screen.queryByText("Chats couldn't be loaded")).toBeNull();
    expect(screen.getByText("No chats yet")).toBeTruthy();
  });

  it("keeps search and list settings visible together", async () => {
    mockSessions([]);
    const onSearch = rs.fn();
    const user = userEvent.setup();

    renderRecentChats("/chat", onSearch);

    await screen.findByText("No chats yet");
    const searchButton = screen.getByRole("button", { name: "Search apps and chats" });
    expect(searchButton).toBeTruthy();
    expect(searchButton.getAttribute("title")).toMatch(/^Search apps and chats \((⌘K|Ctrl K)\)$/);
    expect(screen.getByRole("button", { name: "List settings" })).toBeTruthy();

    await user.click(searchButton);
    expect(onSearch).toHaveBeenCalledOnce();
  });

  it("offers a retry instead of claiming the guardian has no chats when the fetch fails", async () => {
    let attempts = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async () => {
      attempts += 1;
      if (attempts === 1) return new Response("boom", { status: 500 });
      return new Response(
        JSON.stringify([
          {
            id: "recovered",
            name: "Recovered chat",
            createdAt: "2026-07-01T00:00:00.000Z",
            activityAt: "2026-07-01T00:00:00.000Z",
            lastSeenActivityAt: null,
            unread: false,
            projectName: "alpha",
            projectPath: "alpha",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);
    const user = userEvent.setup();

    renderRecentChats();

    expect(await screen.findByText("Chats couldn't be loaded")).toBeTruthy();
    expect(screen.queryByText("No chats yet")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Recovered chat")).toBeTruthy();
    expect(screen.queryByText("Chats couldn't be loaded")).toBeNull();
  });

  it("marks running, failed and finished chats, and drops the open chat's check", async () => {
    const base = {
      createdAt: "2026-07-01T00:00:00.000Z",
      activityAt: "2026-07-09T10:00:00.000Z",
      lastSeenActivityAt: "2026-07-09T09:00:00.000Z",
      projectName: "alpha",
      projectPath: "alpha",
    };
    mockSessions([
      { ...base, id: "running-chat", name: "Running chat", unread: true, running: true },
      { ...base, id: "failed-chat", name: "Failed chat", unread: false, lastTurnFailed: true },
      { ...base, id: "done-chat", name: "Done chat", unread: true },
      {
        ...base,
        id: "waiting-chat",
        name: "Waiting chat",
        unread: true,
        lastTurnFailed: true,
        awaitingGuardian: true,
        projectName: "beta",
        projectPath: "beta",
      },
      { ...base, id: "read-chat", name: "Read chat", unread: false },
      {
        ...base,
        id: "open-chat",
        name: "Open chat",
        unread: true,
        projectName: "beta",
        projectPath: "beta",
      },
    ]);

    renderRecentChats("/chat/open-chat");

    const mark = (name: string) =>
      within(screen.getByText(name).closest("[data-chat-row]") as HTMLElement).queryByRole("img");
    await screen.findByText("Running chat");
    expect(mark("Running chat")?.getAttribute("aria-label")).toBe("Replying now");
    expect(mark("Failed chat")?.getAttribute("aria-label")).toBe("Stopped with an error");
    expect(mark("Done chat")?.getAttribute("aria-label")).toBe("Done · new replies");
    expect(mark("Waiting chat")?.getAttribute("aria-label")).toBe("Waiting for you");
    // An error is a red cross; only "waiting" keeps the orange "!".
    expect(mark("Failed chat")?.querySelector("svg")?.getAttribute("class")).toContain(
      "text-destructive",
    );
    expect(mark("Waiting chat")?.querySelector("svg")?.getAttribute("class")).toContain(
      "text-warning",
    );
    expect(mark("Read chat")).toBeNull();
    expect(mark("Open chat")).toBeNull();
    const doneRow = screen.getByText("Done chat").closest("[data-chat-row]");
    expect(doneRow?.className).toContain("text-ui");
    expect(doneRow?.className).not.toContain("font-medium");
  });

  it.each([
    ["running", { running: true }, "Replying now"],
    ["failed", { lastTurnFailed: true }, "Stopped with an error"],
    ["waiting", { awaitingGuardian: true }, "Waiting for you"],
  ])("keeps the %s mark on the open chat", async (_, state, label) => {
    mockSessions([
      {
        id: "open-chat",
        name: "Open chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: "2026-07-09T10:00:00.000Z",
        unread: false,
        projectName: "alpha",
        projectPath: "alpha",
        ...state,
      },
    ]);

    renderRecentChats("/chat/open-chat");

    expect(await screen.findByRole("img", { name: label })).toBeTruthy();
  });

  describe("status stream", () => {
    const sources: Array<{ url: string; listeners: Map<string, (event: MessageEvent) => void> }> =
      [];
    class FakeEventSource {
      listeners = new Map<string, (event: MessageEvent) => void>();
      constructor(public url: string) {
        sources.push(this);
      }
      addEventListener(name: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(name, listener);
      }
      removeEventListener() {}
      close() {}
    }
    const live = {
      id: "live-chat",
      name: "Live chat",
      createdAt: "2026-07-01T00:00:00.000Z",
      activityAt: "2026-07-09T10:00:00.000Z",
      lastSeenActivityAt: "2026-07-09T10:00:00.000Z",
      unread: false,
      projectName: "alpha",
      projectPath: "alpha",
    };
    const send = (running: boolean) =>
      act(() => {
        sources
          .find((source) => source.url === "/api/chat/status/events")
          ?.listeners.get("session_running")?.(
          new MessageEvent("session_running", {
            data: JSON.stringify({ sessionId: "live-chat", running }),
          }),
        );
      });
    const listCalls = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([input]) => String(input).startsWith("/api/chat/sessions")).length;

    beforeAll(() => {
      rs.stubGlobal("EventSource", FakeEventSource);
    });
    afterEach(() => {
      sources.length = 0;
    });

    it("spins on start and refetches on stop", async () => {
      const fetchSpy = mockSessions([live]);
      renderRecentChats();
      await screen.findByText("Live chat");

      send(true);
      expect(await screen.findByRole("img", { name: "Replying now" })).toBeTruthy();

      const before = listCalls(fetchSpy);
      send(false);
      await waitFor(() => expect(listCalls(fetchSpy)).toBe(before + 1));
      await waitFor(() => expect(screen.queryByRole("img", { name: "Replying now" })).toBeNull());
    });

    it.each([
      ["a failed chat", { lastTurnFailed: true }, "Stopped with an error"],
      ["a chat waiting on the guardian", { awaitingGuardian: true }, "Waiting for you"],
    ])("spins for a new turn of %s", async (_, state, label) => {
      mockSessions([{ ...live, ...state }]);
      renderRecentChats();
      expect(await screen.findByRole("img", { name: label })).toBeTruthy();

      send(true);
      expect(await screen.findByRole("img", { name: "Replying now" })).toBeTruthy();
      expect(screen.queryByRole("img", { name: label })).toBeNull();
    });

    it("keeps a start that arrives while the list is loading", async () => {
      let respond!: () => void;
      rs.spyOn(globalThis, "fetch").mockImplementation((async () => {
        await new Promise<void>((resolve) => {
          respond = resolve;
        });
        return new Response(JSON.stringify([live]), {
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch);
      renderRecentChats();
      await waitFor(() => expect(respond).toBeTypeOf("function"));

      send(true);
      await act(async () => respond());
      expect(await screen.findByRole("img", { name: "Replying now" })).toBeTruthy();
    });
  });

  describe("status over the live-events socket", () => {
    const live = {
      id: "live-chat",
      name: "Live chat",
      createdAt: "2026-07-01T00:00:00.000Z",
      activityAt: "2026-07-09T10:00:00.000Z",
      lastSeenActivityAt: "2026-07-09T10:00:00.000Z",
      unread: false,
      projectName: "alpha",
      projectPath: "alpha",
    };
    const send = (socket: FakeWebSocket, running: boolean) =>
      act(() =>
        socket.receive({
          type: "event",
          topic: "chat.status",
          event: "session_running",
          data: { sessionId: "live-chat", running },
        }),
      );
    const listCalls = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([input]) => String(input).startsWith("/api/chat/sessions")).length;

    beforeEach(() => {
      FakeWebSocket.instances = [];
    });

    it("spins on start, refetches on stop, and starts over from the list after a reconnect", async () => {
      const fetchSpy = mockSessions([live]);
      renderRecentChats("/chat", () => {}, fakeSocketLiveEventsClient());
      await screen.findByText("Live chat");
      let socket!: FakeWebSocket;
      act(() => {
        socket = acceptLatestSocket();
      });
      expect(socket.sent).toEqual([{ type: "subscribe", topic: "chat.status" }]);

      send(socket, true);
      expect(await screen.findByRole("img", { name: "Replying now" })).toBeTruthy();
      const beforeStop = listCalls(fetchSpy);
      send(socket, false);
      await waitFor(() => expect(listCalls(fetchSpy)).toBe(beforeStop + 1));
      await waitFor(() => expect(screen.queryByRole("img", { name: "Replying now" })).toBeNull());

      // A start seen before the drop is dropped too, since its stop may have
      // been missed: the new socket's snapshot names the chats still running.
      send(socket, true);
      expect(await screen.findByRole("img", { name: "Replying now" })).toBeTruthy();
      act(() => socket.close());
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
      const beforeReconnect = listCalls(fetchSpy);
      act(() => {
        acceptLatestSocket();
      });
      await waitFor(() => expect(listCalls(fetchSpy)).toBe(beforeReconnect + 1));
      await waitFor(() => expect(screen.queryByRole("img", { name: "Replying now" })).toBeNull());
    });
  });

  it("lists chats from every project as one list, newest activity first", async () => {
    mockSessions([
      {
        id: "old-active",
        name: "Old but active",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: "2026-07-09T09:00:00.000Z",
        unread: true,
        projectName: "alpha",
        projectPath: "alpha",
      },
      {
        id: "new-inactive",
        name: "New but inactive",
        createdAt: "2026-07-08T00:00:00.000Z",
        activityAt: "2026-07-08T00:00:00.000Z",
        lastSeenActivityAt: "2026-07-08T00:00:00.000Z",
        unread: false,
        projectName: "beta",
        projectPath: "beta",
      },
      {
        id: "default-chat",
        name: "Default chat",
        createdAt: "2026-07-05T00:00:00.000Z",
        activityAt: "2026-07-09T11:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
      },
    ]);

    const { container } = renderRecentChats();

    const list = await screen.findByRole("region", { name: "Recent" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Default chat", "Old but active", "New but inactive"]);
    // No project folders or group headings between the rows.
    expect(screen.queryByRole("button", { name: "alpha" })).toBeNull();
    expect(textIndex(container, "beta")).toBe(-1);
    expect(screen.getAllByRole("img", { name: "Done · new replies" })).toHaveLength(1);
  });

  it("keeps pinned chats in their own block above the list", async () => {
    mockSessions([
      {
        id: "pinned-chat",
        name: "Pinned chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-01T00:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "alpha",
        projectPath: "alpha",
        pinnedAt: "2026-07-09T13:00:00.000Z",
      },
      {
        id: "regular-chat",
        name: "Regular chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "beta",
        projectPath: "beta",
      },
    ]);
    const user = userEvent.setup();

    renderRecentChats();

    const pinnedSection = await screen.findByRole("region", { name: "Pinned" });
    const recentSection = screen.getByRole("region", { name: "Recent" });
    expect(within(pinnedSection).getByRole("link", { name: "Pinned chat" })).toBeTruthy();
    expect(within(recentSection).queryByRole("link", { name: "Pinned chat" })).toBeNull();
    expect(within(recentSection).getByRole("link", { name: "Regular chat" })).toBeTruthy();
    // With something pinned, the list below names itself.
    expect(screen.getByRole("heading", { name: "Recent" })).toBeTruthy();

    await user.click(within(pinnedSection).getByRole("button", { name: "Pinned" }));
    expect(within(pinnedSection).queryByText("Pinned chat")).toBeNull();
  });

  it("names the list without a visible heading when nothing is pinned", async () => {
    mockSessions([
      {
        id: "regular-chat",
        name: "Regular chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "alpha",
        projectPath: "alpha",
      },
    ]);

    renderRecentChats();

    const recentSection = await screen.findByRole("region", { name: "Recent" });
    expect(screen.queryByRole("heading", { name: "Recent" })).toBeNull();
    expect(within(recentSection).getByRole("link", { name: "Regular chat" })).toBeTruthy();
  });

  it("does not render unread dots for the active session", async () => {
    mockSessions([
      {
        id: "active",
        name: "Active session",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: "2026-07-09T09:00:00.000Z",
        unread: true,
        projectName: "alpha",
        projectPath: "alpha",
      },
    ]);

    const { container } = renderRecentChats("/chat/active");

    await waitFor(() => expect(screen.getByText("Active session")).toBeTruthy());
    expect(container.querySelectorAll(".bg-info")).toHaveLength(0);
  });

  it("loads chats twenty at a time", async () => {
    const sessions = Array.from({ length: 45 }, (_, index) => ({
      id: `session-${index + 1}`,
      name: `Session ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 30, 0, 45 - index)).toISOString(),
      activityAt: new Date(Date.UTC(2026, 6, 30, 0, 45 - index)).toISOString(),
      lastSeenActivityAt: null,
      unread: false,
      projectName: index % 2 ? "alpha" : "beta",
      projectPath: index % 2 ? "alpha" : "beta",
    }));
    mockSessions(sessions);
    const user = userEvent.setup();

    renderRecentChats();

    expect(await screen.findByText("Session 20")).toBeTruthy();
    expect(screen.queryByText("Session 21")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load 20 more" }));
    expect(screen.getByText("Session 40")).toBeTruthy();
    expect(screen.queryByText("Session 41")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load 5 more" }));
    expect(screen.getByText("Session 45")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Load \d+ more/ })).toBeNull();
  });

  it.each([
    ["scope", "My chats"],
    ["status", "Active"],
  ])("shows one page again after a %s change", async (_label, item) => {
    const sessions = Array.from({ length: 45 }, (_, index) => ({
      id: `session-${index + 1}`,
      name: `Session ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 30, 0, 45 - index)).toISOString(),
      activityAt: new Date(Date.UTC(2026, 6, 30, 0, 45 - index)).toISOString(),
      lastSeenActivityAt: null,
      unread: false,
      projectName: "alpha",
      projectPath: "alpha",
    }));
    mockSessions(sessions);
    const user = userEvent.setup();

    renderRecentChats();
    await screen.findByText("Session 20");
    await user.click(screen.getByRole("button", { name: "Load 20 more" }));
    expect(screen.getByText("Session 40")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "List settings" }));
    await user.click(screen.getByRole("menuitem", { name: item }));

    await waitFor(() => expect(screen.queryByText("Session 21")).toBeNull());
    expect(screen.getByText("Session 20")).toBeTruthy();
  });

  it("refetches with a status query when the status filter changes", async () => {
    const spy = mockSessions([
      {
        id: "active-1",
        name: "Active chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "alpha",
        projectPath: "alpha",
      },
      {
        id: "archived-1",
        name: "Archived chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-08T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "alpha",
        projectPath: "alpha",
        archivedAt: "2026-07-08T12:00:00.000Z",
      },
    ]);
    const user = userEvent.setup();

    renderRecentChats();
    await screen.findByText("Active chat");
    expect(screen.queryByText("Archived chat")).toBeNull();

    await user.click(screen.getByRole("button", { name: "List settings" }));
    await user.click(screen.getByRole("menuitem", { name: "Archived" }));

    await waitFor(() => expect(screen.getByText("Archived chat")).toBeTruthy());
    expect(screen.queryByText("Active chat")).toBeNull();
    expect(
      spy.mock.calls.some(
        ([url]) => String(url) === "/api/chat/sessions?status=archived&scope=all",
      ),
    ).toBe(true);
  });

  const activeSession = () => ({
    id: "active-1",
    name: "Active chat",
    createdAt: "2026-07-01T00:00:00.000Z",
    activityAt: "2026-07-09T10:00:00.000Z",
    lastSeenActivityAt: null,
    unread: false,
    projectName: "alpha",
    projectPath: "alpha",
  });

  it("archives an active row from the row menu", async () => {
    const spy = mockSessions([activeSession()]);
    const user = userEvent.setup();

    renderRecentChats();
    await screen.findByText("Active chat");

    await user.click(screen.getByRole("button", { name: "Chat actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));

    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            /\/api\/chat\/sessions\/active-1\/archive$/.test(String(url)) &&
            init?.method === "PATCH" &&
            String(init?.body).includes('"archived":true'),
        ),
      ).toBe(true),
    );
  });

  it("pins a concrete chat through the server-backed row action", async () => {
    const spy = mockSessions([activeSession()]);
    const user = userEvent.setup();

    renderRecentChats();
    await screen.findByText("Active chat");

    await user.click(screen.getByRole("button", { name: "Chat actions" }));
    const pinItem = screen.getByRole("menuitem", { name: "Pin chat" });
    expect(pinItem.querySelector(".lucide-pin")).toBeTruthy();
    await user.click(pinItem);

    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            /\/api\/chat\/sessions\/active-1\/pin$/.test(String(url)) &&
            init?.method === "PATCH" &&
            String(init?.body).includes('"pinned":true'),
        ),
      ).toBe(true),
    );
    const pinnedSection = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinnedSection).getByRole("link", { name: "Active chat" })).toBeTruthy();
    expect(screen.getAllByText("Active chat")).toHaveLength(1);
    expect(pinnedSection.querySelector(".lucide-pin")).toBeNull();
    expect(screen.getByTestId("location-path").textContent).toBe("/chat");

    await user.click(within(pinnedSection).getByRole("button", { name: "Chat actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Unpin chat" }).querySelector(".lucide-pin-off"),
    ).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(within(pinnedSection).getByRole("link", { name: "Active chat" }));
    expect(screen.getByTestId("location-path").textContent).toBe("/chat/active-1");
  });

  it("renames a session from the row menu and PATCHes the trimmed name", async () => {
    const spy = mockSessions([activeSession()]);
    const user = userEvent.setup();

    renderRecentChats();
    await screen.findByText("Active chat");

    await user.click(screen.getByRole("button", { name: "Chat actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = await screen.findByRole("textbox", { name: "Chat name" });
    await user.clear(input);
    await user.type(input, "  Renamed chat  {Enter}");

    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            /\/api\/chat\/sessions\/active-1\/name$/.test(String(url)) &&
            init?.method === "PATCH" &&
            String(init?.body).includes('"name":"Renamed chat"'),
        ),
      ).toBe(true),
    );
    expect(screen.getByText("Renamed chat")).toBeTruthy();
  });

  it("leaves focus in the rename input once the menu has closed", async () => {
    // The actions trigger is display:none while the row renames, so Radix's
    // focus restore would land on <body>, blur the input, and commit the
    // rename before a key is typed.
    mockSessions([activeSession()]);
    const user = userEvent.setup();

    renderRecentChats();
    await screen.findByText("Active chat");

    await user.click(screen.getByRole("button", { name: "Chat actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = await screen.findByRole("textbox", { name: "Chat name" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(input);
  });

  it("cancels a rename on Escape without PATCHing", async () => {
    const spy = mockSessions([activeSession()]);
    const user = userEvent.setup();

    renderRecentChats();
    await screen.findByText("Active chat");

    await user.click(screen.getByRole("button", { name: "Chat actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = await screen.findByRole("textbox", { name: "Chat name" });
    await user.clear(input);
    await user.type(input, "Should not save{Escape}");

    await waitFor(() => expect(screen.getByText("Active chat")).toBeTruthy());
    expect(
      spy.mock.calls.some(([url]) => /\/api\/chat\/sessions\/active-1\/name$/.test(String(url))),
    ).toBe(false);
  });

  const archivedSession = () => ({
    id: "archived-1",
    name: "Archived chat",
    createdAt: "2026-07-01T00:00:00.000Z",
    activityAt: "2026-07-08T10:00:00.000Z",
    lastSeenActivityAt: null,
    unread: false,
    projectName: "alpha",
    projectPath: "alpha",
    archivedAt: "2026-07-08T12:00:00.000Z",
  });

  it("unarchives from the archived-row menu", async () => {
    localStorage.setItem("rome-recent-chats-status-filter", "all");
    const spy = mockSessions([archivedSession()]);
    const user = userEvent.setup();

    renderRecentChats();
    await screen.findByText("Archived chat");

    await user.click(screen.getByRole("button", { name: "Chat actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Unarchive chat" }));
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            /\/api\/chat\/sessions\/archived-1\/archive$/.test(String(url)) &&
            init?.method === "PATCH" &&
            String(init?.body).includes('"archived":false'),
        ),
      ).toBe(true),
    );
  });

  it("grays out archived chat rows", async () => {
    localStorage.setItem("rome-recent-chats-status-filter", "all");
    mockSessions([activeSession(), archivedSession()]);

    renderRecentChats();

    const archivedRow = (await screen.findByText("Archived chat")).closest("[data-chat-row]");
    const activeRow = screen.getByText("Active chat").closest("[data-chat-row]");
    expect(archivedRow?.classList.contains("text-subtle-foreground")).toBe(true);
    expect(archivedRow?.classList.contains("text-foreground")).toBe(false);
    expect(activeRow?.classList.contains("text-foreground")).toBe(true);
  });

  it("deletes from the archived-row menu after confirmation", async () => {
    localStorage.setItem("rome-recent-chats-status-filter", "all");
    const spy = mockSessions([archivedSession()]);
    const user = userEvent.setup();

    renderRecentChats();
    await screen.findByText("Archived chat");

    await user.click(screen.getByRole("button", { name: "Chat actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete" });
    expect(
      spy.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/chat/sessions/archived-1" && init?.method === "DELETE",
      ),
    ).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/chat/sessions/archived-1" && init?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });
});

describe("RecentChats row menu shortcuts", () => {
  const activeSession = () => ({
    id: "active-1",
    name: "Active chat",
    createdAt: "2026-07-09T10:00:00.000Z",
    activityAt: "2026-07-09T10:00:00.000Z",
    lastSeenActivityAt: null,
    unread: false,
    projectName: "alpha",
    projectPath: "alpha",
  });

  const archivedSession = () => ({
    ...activeSession(),
    id: "archived-1",
    name: "Archived chat",
    archivedAt: "2026-07-08T12:00:00.000Z",
  });

  async function openRowMenu() {
    const user = userEvent.setup();
    renderRecentChats();
    await screen.findByRole("link");
    await user.click(screen.getByRole("button", { name: "Chat actions" }));
    return user;
  }

  it("archives the row on A", async () => {
    const spy = mockSessions([activeSession()]);
    const user = await openRowMenu();

    await user.keyboard("a");

    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            /\/api\/chat\/sessions\/active-1\/archive$/.test(String(url)) &&
            init?.method === "PATCH" &&
            String(init?.body).includes('"archived":true'),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("unarchives an archived row on A", async () => {
    localStorage.setItem("rome-recent-chats-status-filter", "all");
    const spy = mockSessions([archivedSession()]);
    const user = await openRowMenu();

    await user.keyboard("a");

    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            /\/api\/chat\/sessions\/archived-1\/archive$/.test(String(url)) &&
            init?.method === "PATCH" &&
            String(init?.body).includes('"archived":false'),
        ),
      ).toBe(true),
    );
  });

  it("pins the row on P", async () => {
    const spy = mockSessions([activeSession()]);
    const user = await openRowMenu();

    await user.keyboard("p");

    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            /\/api\/chat\/sessions\/active-1\/pin$/.test(String(url)) &&
            init?.method === "PATCH" &&
            String(init?.body).includes('"pinned":true'),
        ),
      ).toBe(true),
    );
  });

  it("opens the rename input on R", async () => {
    mockSessions([activeSession()]);
    const user = await openRowMenu();

    await user.keyboard("r");

    const input = await screen.findByRole("textbox", { name: "Chat name" });
    expect((input as HTMLInputElement).value).toBe("Active chat");
  });

  it("leaves the letter to the browser when a modifier is held", async () => {
    const spy = mockSessions([activeSession()]);
    const user = await openRowMenu();

    await user.keyboard("{Control>}a{/Control}");

    expect(
      spy.mock.calls.some(([url]) => /\/api\/chat\/sessions\/active-1\/archive$/.test(String(url))),
    ).toBe(false);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("keeps the hint out of the item's accessible name", async () => {
    mockSessions([activeSession()]);
    await openRowMenu();

    const archive = screen.getByRole("menuitem", { name: "Archive" });
    expect(archive.getAttribute("aria-keyshortcuts")).toBe("A");
    expect(archive.textContent).toContain("A");
  });

  it("binds no letter to Delete", async () => {
    const spy = mockSessions([activeSession()]);
    const user = await openRowMenu();

    expect(screen.getByRole("menuitem", { name: "Delete" }).hasAttribute("aria-keyshortcuts")).toBe(
      false,
    );

    await user.keyboard("d");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(spy.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
});

describe("RecentChats chat name tooltip", () => {
  const longNameSession = (name: string) => ({
    id: "long-1",
    name,
    createdAt: "2026-07-01T00:00:00.000Z",
    activityAt: "2026-07-09T10:00:00.000Z",
    lastSeenActivityAt: null,
    unread: false,
    projectName: "alpha",
    projectPath: "alpha",
  });

  // jsdom performs no layout, so scrollWidth/clientWidth are both 0 and the
  // row's "is the name clipped?" probe reads false. Fake the geometry of a
  // clipped name on the label span to exercise the tooltip path.
  function fakeClippedName(el: HTMLElement) {
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: 320 });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: 140 });
  }

  it("reveals the full chat name in a tooltip when hovering a row whose name is truncated", async () => {
    const name = "Rewrite the session archive migration end to end";
    mockSessions([longNameSession(name)]);
    const user = userEvent.setup();

    renderRecentChats();

    const label = await screen.findByText(name);
    fakeClippedName(label);
    await user.hover(label);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe(name);
  });

  it.each([
    ["", {}],
    [" and the chat has a status mark", { lastTurnFailed: true }],
  ])("shows no tooltip when the chat name fits in the row%s", async (_, state) => {
    mockSessions([{ ...longNameSession("Short chat"), ...state }]);
    const user = userEvent.setup();

    renderRecentChats();

    // Untouched jsdom geometry (0/0) is exactly a name that fits.
    await user.hover(await screen.findByText("Short chat"));

    // Outwait the tooltip open delay before concluding nothing appeared.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
