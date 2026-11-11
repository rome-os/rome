// @rstest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import i18n from "@/i18n";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import type { LiveEventsClient } from "@/lib/live-events";
import {
  acceptLatestSocket,
  FakeWebSocket,
  fakeSocketLiveEventsClient,
} from "@/test/fake-websocket";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };
import { chatSessionTopicName } from "@rome/api-types/live-events";
import { emitSessionsChanged } from "@/lib/session-events";
import { RecentChats } from "./RecentChats";

// Concierge's chat id comes from its own query, which these tests do not
// serve; each test that needs the entry sets the id here.
const concierge = rs.hoisted(() => ({
  chatId: null as string | null,
  chats: [] as Array<{ id: string; name: string; main: boolean; unread: number }>,
  // Reads the Concierge's list from the server, so a refetch shows.
  fromServer: false,
}));
rs.mock("@/hooks/use-concierge", () => ({
  ...conciergeModule,
  useConciergeChatId: () => concierge.chatId,
  useConciergeChats: () =>
    concierge.fromServer ? conciergeModule.useConciergeChats() : concierge.chats,
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.useRealTimers();
  localStorage.clear();
  rs.restoreAllMocks();
  concierge.chatId = null;
  concierge.chats = [];
  concierge.fromServer = false;
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
  agentName?: string;
  triggerKind?: string;
  deviceFolder?: { deviceId: string; deviceName: string; platform: string | null; path: string };
}

function mockSessions(sessions: MockSession[], settings?: Record<string, unknown>) {
  const spy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/settings" && settings) return Response.json(settings);
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

function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// A fresh cache per mount unless a test passes one in to remount against it.
function renderRecentChats(
  initialEntry = "/chat",
  live?: LiveEventsClient,
  queryClient = testQueryClient(),
) {
  const routed = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <RecentChats />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
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
  return (
    <>
      <output data-testid="location-path">{location.pathname}</output>
      <output data-testid="location-state">{JSON.stringify(location.state)}</output>
    </>
  );
}

function textIndex(container: HTMLElement, text: string): number {
  return container.textContent?.indexOf(text) ?? -1;
}

describe("RecentChats", () => {
  it("lists the main chat as Main chat, keeps Concierge chats out of Projects, and puts task chats under their project", async () => {
    concierge.chatId = "concierge";
    const row = (id: string, name: string) => ({
      id,
      name,
      createdAt: new Date().toISOString(),
      activityAt: new Date().toISOString(),
      lastSeenActivityAt: null,
      unread: false,
      projectName: "default",
      projectPath: "default",
    });
    mockSessions(
      [
        { ...row("concierge", "Concierge"), agentName: "core:concierge" } as MockSession,
        { ...row("task-1", "Find flights"), triggerKind: "concierge" } as MockSession,
        { ...row("mine", "My own chat") },
      ],
      { agentName: "Milo" },
    );
    renderRecentChats();
    const entry = await screen.findByRole("link", { name: "Main chat" });
    expect(entry.getAttribute("href")).toBe("/message");
    await screen.findByRole("link", { name: "My own chat" });
    const task = await screen.findByRole("link", { name: /Find flights/ });
    expect(task.getAttribute("href")).toBe("/chat/task-1");
    expect(screen.queryByRole("link", { name: /^(Milo|Concierge)$/ })).toBeNull();
  });

  it("gives a task chat's row the same status and menu as a common chat's", async () => {
    const user = userEvent.setup();
    const row = (id: string, name: string, extra: Partial<MockSession> = {}) =>
      ({
        id,
        name,
        createdAt: new Date().toISOString(),
        activityAt: new Date().toISOString(),
        lastSeenActivityAt: null,
        unread: true,
        running: false,
        projectName: "default",
        projectPath: "default",
        ...extra,
      }) as MockSession;
    mockSessions([
      row("task-1", "Find flights", { triggerKind: "concierge" }),
      row("mine", "My own chat"),
    ]);
    renderRecentChats();
    const rowOf = async (name: string) =>
      (await screen.findByRole("link", { name: new RegExp(`^${name}`) })).closest<HTMLElement>(
        "[data-chat-row]",
      )!;
    const shape = async (name: string) => {
      const chatRow = await rowOf(name);
      const status =
        within(chatRow)
          .queryAllByRole("img")
          .map((img) => img.getAttribute("aria-label"))
          .find((label) => !label?.startsWith("Started by")) ?? null;
      await user.click(within(chatRow).getByRole("button", { name: "Chat actions" }));
      const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
      await user.keyboard("{Escape}");
      return { status, items, className: chatRow.className };
    };
    const task = await shape("Find flights");
    expect(task.status).toBe("Done · new replies");
    expect(task).toEqual(await shape("My own chat"));
  });

  it("marks a task chat's row as started by the Concierge, and a common chat's not", async () => {
    concierge.chatId = "concierge";
    const row = (id: string, name: string, extra: Partial<MockSession> = {}) =>
      ({
        id,
        name,
        createdAt: new Date().toISOString(),
        activityAt: new Date().toISOString(),
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
        ...extra,
      }) as MockSession;
    mockSessions(
      [row("task-1", "Find flights", { triggerKind: "concierge" }), row("mine", "My own chat")],
      { agentName: "Milo" },
    );
    renderRecentChats();
    const rowOf = async (name: string) =>
      (await screen.findByRole("link", { name: new RegExp(name) })).closest<HTMLElement>(
        "[data-chat-row]",
      )!;
    const task = await rowOf("Find flights");
    await waitFor(() =>
      expect(within(task).getByRole("img", { name: "Started by Milo" })).toBeTruthy(),
    );
    const mine = await rowOf("My own chat");
    expect(within(mine).queryByRole("img", { name: /Started by/ })).toBeNull();
    expect(mine.querySelectorAll("svg").length).toBe(task.querySelectorAll("svg").length - 1);
  });

  it("marks the row it opens at once, while the router still holds the old chat", async () => {
    mockSessions(
      ["task-1", "mine"].map(
        (id) =>
          ({
            id,
            name: id === "mine" ? "My own chat" : "Find flights",
            createdAt: new Date().toISOString(),
            activityAt: new Date().toISOString(),
            lastSeenActivityAt: null,
            unread: false,
            projectName: "default",
            projectPath: "default",
            ...(id === "task-1" ? { triggerKind: "concierge" } : {}),
          }) as MockSession,
      ),
    );
    // The task chat's page holds its render until released, so the router's
    // transition stays open, as on a long chat that takes a moment.
    let release = () => {};
    let released = false;
    const held = new Promise<void>((resolve) => {
      release = () => {
        released = true;
        resolve();
      };
    });
    function Page() {
      const { id } = useParams();
      if (id === "task-1" && !released) throw held;
      return null;
    }
    render(
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter initialEntries={["/chat/mine"]}>
          <RecentChats />
          <LocationProbe />
          <Suspense fallback={null}>
            <Routes>
              <Route path="/chat/:id" element={<Page />} />
            </Routes>
          </Suspense>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const rowOf = async (name: string) =>
      (await screen.findByRole("link", { name: new RegExp(`^${name}`) })).closest<HTMLElement>(
        "[data-chat-row]",
      )!;
    expect((await rowOf("My own chat")).className).toContain("bg-surface shadow-1");
    await userEvent.setup().click(await screen.findByRole("link", { name: /^Find flights/ }));
    expect((await rowOf("Find flights")).className).toContain("bg-surface shadow-1");
    expect((await rowOf("My own chat")).className).not.toContain("bg-surface shadow-1");
    expect(screen.getByTestId("location-path").textContent).toBe("/chat/mine");

    // A click back on the open chat before the other one renders: the mark
    // returns to it.
    await userEvent.setup().click(await screen.findByRole("link", { name: /^My own chat/ }));
    expect((await rowOf("My own chat")).className).toContain("bg-surface shadow-1");
    expect((await rowOf("Find flights")).className).not.toContain("bg-surface shadow-1");

    // Opening the other chat again, and letting it render.
    await userEvent.setup().click(await screen.findByRole("link", { name: /^Find flights/ }));
    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByTestId("location-path").textContent).toBe("/chat/task-1"),
    );
    expect((await rowOf("Find flights")).className).toContain("bg-surface shadow-1");
  });

  it("applies the status filter to task chats like any other chat", async () => {
    localStorage.setItem("rome-recent-chats-status-filter", "all");
    mockSessions([
      {
        id: "task-1",
        name: "Find flights",
        createdAt: new Date().toISOString(),
        activityAt: new Date().toISOString(),
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
        archivedAt: "2026-07-09T13:00:00.000Z",
        triggerKind: "concierge",
      } as MockSession,
      {
        id: "old",
        name: "Old chat",
        createdAt: new Date().toISOString(),
        activityAt: new Date().toISOString(),
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
        archivedAt: "2026-07-09T13:00:00.000Z",
      },
    ]);
    renderRecentChats();
    await screen.findByRole("link", { name: "Old chat" });
    expect(await screen.findByRole("link", { name: /Find flights/ })).toBeTruthy();
  });

  describe("Concierge topic chats", () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const mockTopics = () =>
      rs.spyOn(globalThis, "fetch").mockImplementation((async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        }
        const body =
          url === "/api/concierge/chats" && method === "POST"
            ? { id: "topic-2", name: "Trips", main: false, unread: 0 }
            : url.startsWith("/api/chat/sessions") && method === "GET"
              ? []
              : url === "/api/concierge/session"
                ? { id: "concierge", unread: 0 }
                : url.startsWith("/api/concierge/tasks")
                  ? { tasks: [] }
                  : method !== "GET"
                    ? {}
                    : null;
        if (body === null) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch);

    beforeEach(() => {
      requests.length = 0;
      concierge.chatId = "concierge";
      concierge.chats = [
        { id: "concierge", name: "Concierge", main: true, unread: 0 },
        { id: "topic-1", name: "Calendar", main: false, unread: 2 },
      ];
    });

    it("lists each topic chat under the Concierge entry, with its unread count", async () => {
      mockTopics();
      renderRecentChats();
      const entry = await screen.findByRole("link", { name: "Calendar, 2 unread messages" });
      expect(entry.getAttribute("href")).toBe("/chat/topic-1");
      // The main chat is the Concierge entry, not a row of its own.
      expect(screen.queryByRole("link", { name: /^Concierge, / })).toBeNull();
    });

    it("opens a blank topic chat from the plus beside the Concierge entry, creating nothing yet", async () => {
      mockTopics();
      const user = userEvent.setup();
      renderRecentChats();
      await user.click(await screen.findByRole("button", { name: "New topic chat" }));
      expect(screen.getByTestId("location-path").textContent).toBe("/chat");
      expect(screen.getByTestId("location-state").textContent).toBe('{"conciergeTopic":true}');
      // Like a new chat, nothing exists until the first send.
      expect(requests).toEqual([]);
      expect(screen.queryByRole("textbox")).toBeNull();
    });

    it("archives an open topic chat from its menu and returns to the main chat", async () => {
      mockTopics();
      const user = userEvent.setup();
      renderRecentChats("/chat/topic-1");
      await user.click(await screen.findByRole("button", { name: "Actions for Calendar" }));
      await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
      await waitFor(() =>
        expect(requests).toContainEqual({
          url: "/api/chat/sessions/topic-1/archive",
          method: "PATCH",
          body: { archived: true },
        }),
      );
      await waitFor(() => expect(screen.getByTestId("location-path").textContent).toBe("/message"));
    });
  });

  describe("Concierge unread badge", () => {
    const server = { unread: 0, tasks: [] as unknown[], settings: {} as Record<string, unknown> };
    const conciergeCalls = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([input]) => String(input) === "/api/concierge/session").length;
    const mockConcierge = () =>
      rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith("/api/chat/sessions")
          ? []
          : url === "/api/settings"
            ? server.settings
            : url === "/api/concierge/session"
              ? { id: "concierge", unread: server.unread }
              : url.startsWith("/api/concierge/tasks")
                ? { tasks: server.tasks }
                : null;
        if (body === null) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch);

    beforeEach(() => {
      concierge.chatId = "concierge";
      server.unread = 0;
      server.tasks = [];
      server.settings = {};
      FakeWebSocket.instances = [];
    });

    const taskRow = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
      id,
      title: `Task ${id}`,
      state,
      summary: null,
      waitingOn: null,
      dueAt: null,
      rank: null,
      chat: null,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
      archivedAt: null,
      notSynced: false,
      conciergeChat: { id: "concierge", name: "Concierge", main: true },
      ...extra,
    });

    it("counts unread messages", async () => {
      server.unread = 3;
      mockConcierge();
      renderRecentChats();
      expect(
        await screen.findByRole("link", { name: "Main chat, 3 unread messages" }),
      ).toBeTruthy();
    });

    it("says Main chat, not the name the guardian gave their agent", async () => {
      server.unread = 3;
      server.settings = { agentName: " Milo " };
      mockConcierge();
      renderRecentChats();
      const entry = await screen.findByRole("link", { name: "Main chat, 3 unread messages" });
      expect(entry.textContent).toContain("Main chat");
      expect(screen.queryByRole("link", { name: /Milo/ })).toBeNull();
    });

    it("lights the entry at /message, the main chat's page, and not elsewhere", async () => {
      server.unread = 3;
      mockConcierge();
      const view = renderRecentChats("/message");
      const entry = await screen.findByRole("link", { name: "Main chat" });
      expect(entry.getAttribute("href")).toBe("/message");
      expect(entry.className).toContain("shadow-1");
      view.unmount();

      renderRecentChats("/chat");
      expect((await screen.findByRole("link", { name: /^Main chat, 3/ })).className).not.toContain(
        "shadow-1",
      );
    });

    it("shows no badge at 0", async () => {
      const fetchSpy = mockConcierge();
      renderRecentChats();
      await waitFor(() => expect(conciergeCalls(fetchSpy)).toBeGreaterThan(0));
      await act(async () => {});
      expect(await screen.findByRole("link", { name: "Main chat" })).toBeTruthy();
      expect(document.querySelector("[data-concierge-unread]")).toBeNull();
    });

    it("caps the count at 99+", async () => {
      server.unread = 100;
      mockConcierge();
      renderRecentChats();
      const entry = await screen.findByRole("link", { name: "Main chat, 99+ unread messages" });
      expect(entry.querySelector("[data-concierge-unread]")?.textContent).toContain("99+");
    });

    it("shows no tasks badge, even when tasks need the guardian", async () => {
      server.unread = 3;
      server.tasks = [taskRow("a", "needs_user"), taskRow("b", "needs_user")];
      mockConcierge();
      renderRecentChats();
      // The link's label is the unread count alone: the tasks live in the chat's pill.
      const entry = await screen.findByRole("link", { name: "Main chat, 3 unread messages" });
      expect(
        within(entry)
          .getAllByRole("img")
          .map((badge) => badge.getAttribute("aria-label")),
      ).toEqual(["3 unread messages"]);
      expect(screen.queryByText(/tasks? needs? you/)).toBeNull();
    });

    it("puts the plus in the unread badge's place on hover or focus, so they never overlap", async () => {
      server.unread = 3;
      mockConcierge();
      renderRecentChats();
      const entry = await screen.findByRole("link", { name: "Main chat, 3 unread messages" });
      const badge = entry.querySelector("[data-concierge-unread]") as HTMLElement;
      const plus = screen.getByRole("button", { name: "New topic chat" });
      // The badge hides exactly when the plus shows: on the row's hover or focus.
      for (const state of ["group-hover/concierge", "group-focus-within/concierge"]) {
        expect(badge.className).toContain(`${state}:invisible`);
        expect(plus.className).toContain(`${state}:opacity-100`);
      }
      expect(plus.className).toContain("opacity-0");
      // With a badge to show, a touch screen keeps the badge, not the plus.
      expect(plus.className).not.toContain("touch-show");
    });

    it("keeps the plus within reach on a touch screen while nothing is unread", async () => {
      mockConcierge();
      renderRecentChats();
      await screen.findByRole("link", { name: "Main chat" });
      expect(document.querySelector("[data-concierge-unread]")).toBeNull();
      expect(screen.getByRole("button", { name: "New topic chat" }).className).toContain(
        "touch-show",
      );
    });

    it("shows no badge on the Concierge page", async () => {
      server.unread = 3;
      const fetchSpy = mockConcierge();
      renderRecentChats("/message");
      await waitFor(() => expect(conciergeCalls(fetchSpy)).toBeGreaterThan(0));
      await act(async () => {});
      expect(screen.getByRole("link", { name: "Main chat" })).toBeTruthy();
      expect(document.querySelector("[data-concierge-unread]")).toBeNull();
    });

    it("recounts on a new Concierge message and on a read in this tab", async () => {
      const fetchSpy = mockConcierge();
      renderRecentChats("/chat", fakeSocketLiveEventsClient());
      await waitFor(() => expect(conciergeCalls(fetchSpy)).toBe(1));
      let socket!: FakeWebSocket;
      act(() => {
        socket = acceptLatestSocket();
      });
      expect(socket.sent).toContainEqual({
        type: "subscribe",
        topic: chatSessionTopicName("concierge"),
      });

      server.unread = 1;
      act(() =>
        socket.receive({
          type: "event",
          topic: chatSessionTopicName("concierge"),
          event: "message_insert",
          data: { id: "m1", sessionId: "concierge", role: "assistant" },
        }),
      );
      expect(await screen.findByRole("link", { name: "Main chat, 1 unread message" })).toBeTruthy();

      server.unread = 0;
      act(() => emitSessionsChanged());
      await waitFor(() => expect(document.querySelector("[data-concierge-unread]")).toBeNull());
    });
  });

  it("defaults to My chats and persists a scope toggle across remounts", async () => {
    const fetchSpy = mockSessions([]);
    const user = userEvent.setup();
    const view = renderRecentChats();
    const requestedScope = () =>
      new URL(
        String(
          fetchSpy.mock.calls
            .filter(([input]) => String(input).startsWith("/api/chat/sessions"))
            .at(-1)?.[0],
        ),
        "http://localhost",
      ).searchParams.get("scope");
    await waitFor(() => expect(requestedScope()).toBe("mine"));
    await user.click(screen.getByRole("button", { name: "List settings" }));
    const mine = screen.getByRole("menuitem", { name: "My chats" });
    expect(mine.querySelector("svg")).not.toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "All chats" }));
    await waitFor(() => expect(requestedScope()).toBe("all"));
    expect(localStorage.getItem("rome-recent-chats-scope")).toBe("all");
    view.unmount();
    const remounted = renderRecentChats();
    await waitFor(() => expect(requestedScope()).toBe("all"));
    await user.click(screen.getByRole("button", { name: "List settings" }));
    expect(screen.getByRole("menuitem", { name: "All chats" }).querySelector("svg")).not.toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "My chats" }));
    await waitFor(() => expect(requestedScope()).toBe("mine"));
    expect(localStorage.getItem("rome-recent-chats-scope")).toBe("mine");
    remounted.unmount();
  });

  it.each([
    ["All chats", 200],
    ["All chats", 500],
    ["Archived", 200],
    ["Archived", 500],
  ])("ignores a stale %s list response with status %s", async (selection, status) => {
    let respond!: (response: Response) => void;
    // Only the chat list is counted: the sidebar's other reads (the settings
    // behind the Concierge's name) are not what this test is about.
    let listRequests = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      if (!String(input).startsWith("/api/chat/sessions")) {
        return new Response("not found", { status: 404 });
      }
      listRequests += 1;
      if (listRequests > 1) return new Response(JSON.stringify([]), { status: 200 });
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    }) as typeof fetch);
    const user = userEvent.setup();
    renderRecentChats();
    await waitFor(() => expect(listRequests).toBe(1));

    await user.click(screen.getByRole("button", { name: "List settings" }));
    await user.click(screen.getByRole("menuitem", { name: selection }));
    await screen.findByRole("button", { name: "default" });
    expect(listRequests).toBe(2);

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
    expect(screen.getByRole("button", { name: "default" })).toBeTruthy();
  });

  it("has no New chat link, and no new chat button on the Projects heading", async () => {
    mockSessions([]);

    renderRecentChats("/chat/session-1");

    await screen.findByRole("button", { name: "default" });
    expect(screen.queryByRole("link", { name: "New chat" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
    // A common chat starts from a project row's plus instead.
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
  });

  it("leaves search to the rail and keeps the list settings in its header", async () => {
    mockSessions([]);

    renderRecentChats("/chat");

    await screen.findByRole("button", { name: "default" });
    expect(screen.queryByRole("button", { name: "Search pages, apps, and chats" })).toBeNull();
    expect(screen.getByRole("button", { name: "List settings" })).toBeTruthy();
  });

  it("shows the cached list at once on remount and refetches behind it", async () => {
    const fetchSpy = mockSessions([
      {
        id: "cached",
        name: "Cached chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-01T00:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "alpha",
        projectPath: "alpha",
      },
    ]);
    const listCalls = () =>
      fetchSpy.mock.calls.filter(([input]) => String(input).startsWith("/api/chat/sessions"))
        .length;
    const queryClient = testQueryClient();
    const view = renderRecentChats("/chat", undefined, queryClient);
    await screen.findByText("Cached chat");
    view.unmount();
    const before = listCalls();

    renderRecentChats("/chat", undefined, queryClient);

    // Synchronously, before any response: the rows, not the skeleton.
    expect(screen.getByText("Cached chat")).toBeTruthy();
    await waitFor(() => expect(listCalls()).toBe(before + 1));
  });

  it("still shows the cached list after a long time away", async () => {
    mockSessions([
      {
        id: "cached",
        name: "Cached chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-01T00:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "alpha",
        projectPath: "alpha",
      },
    ]);
    const queryClient = testQueryClient();
    const view = renderRecentChats("/chat", undefined, queryClient);
    await screen.findByText("Cached chat");
    rs.useFakeTimers();
    view.unmount();
    // Past React Query's default five-minute garbage collection.
    await act(async () => {
      await rs.advanceTimersByTimeAsync(10 * 60_000);
    });

    renderRecentChats("/chat", undefined, queryClient);

    expect(screen.getByText("Cached chat")).toBeTruthy();
  });

  it("still shows the cached topic chats after a long time away", async () => {
    concierge.chatId = "concierge";
    concierge.fromServer = true;
    let conciergeCalls = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/chat/sessions")) return Response.json([]);
      if (url === "/api/concierge/chats") {
        conciergeCalls += 1;
        return Response.json({
          chats: [
            { id: "concierge", name: "Concierge", main: true, unread: 0 },
            { id: "topic-1", name: "Cached topic", main: false, unread: 0 },
          ],
        });
      }
      if (url === "/api/concierge/session") return Response.json({ id: "concierge", unread: 0 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch);
    const queryClient = testQueryClient();
    const view = renderRecentChats("/chat", undefined, queryClient);
    await screen.findByRole("link", { name: "Cached topic" });
    rs.useFakeTimers();
    view.unmount();
    // Past React Query's default five-minute garbage collection.
    await act(async () => {
      await rs.advanceTimersByTimeAsync(10 * 60_000);
    });
    const before = conciergeCalls;

    renderRecentChats("/chat", undefined, queryClient);

    // Synchronously, before any response: the cached topic chat, which the
    // remount still refetches behind.
    expect(screen.getByRole("link", { name: "Cached topic" })).toBeTruthy();
    rs.useRealTimers();
    await waitFor(() => expect(conciergeCalls).toBe(before + 1));
  });

  it("offers a retry instead of claiming the guardian has no chats when the fetch fails", async () => {
    let attempts = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      if (!String(input).startsWith("/api/chat/sessions")) {
        return new Response("not found", { status: 404 });
      }
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
    // The running ring turns on an HTML box: Chrome animates an SVG's
    // transform on the main thread, once per display frame.
    const spinner = mark("Running chat")?.querySelector(".rome-status-spin");
    expect(spinner?.tagName).toBe("SPAN");
    expect(mark("Running chat")?.querySelector("svg")?.getAttribute("class")).not.toMatch(/spin/);
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

    it("drops a cached spinner on remount once the refetch says the turn stopped", async () => {
      mockSessions([live]);
      const queryClient = testQueryClient();
      const view = renderRecentChats("/chat", undefined, queryClient);
      await screen.findByText("Live chat");
      send(true);
      expect(await screen.findByRole("img", { name: "Replying now" })).toBeTruthy();
      // The stop arrives while the list is unmounted, so only the refetch
      // can tell the remounted list about it.
      view.unmount();

      renderRecentChats("/chat", undefined, queryClient);

      expect(screen.getByText("Live chat")).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("img", { name: "Replying now" })).toBeNull());
    });

    it("keeps a start that arrives while the list is loading", async () => {
      let respond!: () => void;
      rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
        if (!String(input).startsWith("/api/chat/sessions")) return Response.json({});
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
      renderRecentChats("/chat", fakeSocketLiveEventsClient());
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

  describe("a chat the list does not have yet", () => {
    const listed = {
      id: "listed-chat",
      name: "Listed chat",
      createdAt: "2026-07-01T00:00:00.000Z",
      activityAt: "2026-07-09T10:00:00.000Z",
      lastSeenActivityAt: "2026-07-09T10:00:00.000Z",
      unread: false,
      projectName: "alpha",
      projectPath: "alpha",
    };
    const started = { ...listed, id: "new-task", name: "New task chat" };
    const running = (socket: FakeWebSocket, sessionId: string, value = true) =>
      act(() =>
        socket.receive({
          type: "event",
          topic: "chat.status",
          event: "session_running",
          data: { sessionId, running: value },
        }),
      );
    const listCalls = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([input]) => String(input).startsWith("/api/chat/sessions")).length;

    beforeEach(() => {
      FakeWebSocket.instances = [];
    });

    it("asks for the list once when the chat starts running, and shows it running", async () => {
      const stored = [listed];
      const fetchSpy = mockSessions(stored);
      renderRecentChats("/chat", fakeSocketLiveEventsClient());
      await screen.findByText("Listed chat");
      let socket!: FakeWebSocket;
      act(() => {
        socket = acceptLatestSocket();
      });
      const before = listCalls(fetchSpy);

      stored.push(started);
      running(socket, "new-task");

      expect(await screen.findByText("New task chat")).toBeTruthy();
      expect(listCalls(fetchSpy)).toBe(before + 1);
      expect(await screen.findByRole("img", { name: "Replying now" })).toBeTruthy();
      // Listed now, so its next start asks for nothing.
      running(socket, "new-task", false);
      await waitFor(() => expect(listCalls(fetchSpy)).toBe(before + 2));
      running(socket, "new-task");
      await act(async () => {});
      expect(listCalls(fetchSpy)).toBe(before + 2);
    });

    it("remembers a chat that is still not listed after the refetch, and never asks for it again", async () => {
      const fetchSpy = mockSessions([listed]);
      renderRecentChats("/chat", fakeSocketLiveEventsClient());
      await screen.findByText("Listed chat");
      let socket!: FakeWebSocket;
      act(() => {
        socket = acceptLatestSocket();
      });
      const before = listCalls(fetchSpy);

      running(socket, "elsewhere");
      await waitFor(() => expect(listCalls(fetchSpy)).toBe(before + 1));
      await act(async () => {});
      running(socket, "elsewhere");
      running(socket, "elsewhere");
      await act(async () => {});
      expect(listCalls(fetchSpy)).toBe(before + 1);

      // Another chat that is not listed gets its own single ask.
      running(socket, "another");
      await waitFor(() => expect(listCalls(fetchSpy)).toBe(before + 2));
    });

    it("asks once for a chat that starts running twice before the first refetch lands", async () => {
      const fetchSpy = mockSessions([listed]);
      renderRecentChats("/chat", fakeSocketLiveEventsClient());
      await screen.findByText("Listed chat");
      let socket!: FakeWebSocket;
      act(() => {
        socket = acceptLatestSocket();
      });
      const before = listCalls(fetchSpy);
      running(socket, "new-task");
      running(socket, "new-task");
      await act(async () => {});
      await waitFor(() => expect(listCalls(fetchSpy)).toBe(before + 1));
    });

    it("does not ask for a chat the list already has", async () => {
      const fetchSpy = mockSessions([listed]);
      renderRecentChats("/chat", fakeSocketLiveEventsClient());
      await screen.findByText("Listed chat");
      let socket!: FakeWebSocket;
      act(() => {
        socket = acceptLatestSocket();
      });
      const before = listCalls(fetchSpy);
      running(socket, "listed-chat");
      await act(async () => {});
      expect(listCalls(fetchSpy)).toBe(before);
    });
  });

  it("sorts project groups and sessions by activity time", async () => {
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
    ]);

    const { container } = renderRecentChats();

    await screen.findByText("Old but active");
    expect(textIndex(container, "alpha")).toBeLessThan(textIndex(container, "beta"));
    expect(textIndex(container, "Old but active")).toBeLessThan(
      textIndex(container, "New but inactive"),
    );
    expect(screen.getAllByRole("img", { name: "Done · new replies" })).toHaveLength(1);
  });

  it("leads the project groups with the default project, whatever moved last", async () => {
    mockSessions([
      {
        id: "alpha-chat",
        name: "Alpha chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "Alpha project",
        projectPath: "alpha",
      },
      {
        id: "default-chat",
        name: "Default chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-02T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
      },
    ]);
    const user = userEvent.setup();
    const { container } = renderRecentChats();

    const projects = await screen.findByRole("region", { name: "Projects" });
    await within(projects).findByRole("link", { name: "Default chat" });
    expect(textIndex(container, "Default chat")).toBeLessThan(textIndex(container, "Alpha chat"));

    // Each project row starts a chat in its own project.
    const alphaRow = within(projects).getByRole("button", { name: "Alpha project" })
      .parentElement as HTMLElement;
    const plus = within(alphaRow).getByRole("button", { name: "New chat in this project" });
    expect(plus.className).toContain("group-hover/project:opacity-100");
    expect(plus.className).toContain("touch-show");
    await user.click(plus);
    expect(screen.getByTestId("location-path").textContent).toBe("/chat");
    expect(screen.getByTestId("location-state").textContent).toBe('{"projectPath":"alpha"}');
  });

  it("shows the default project as just its row, with its plus, when it has no chats", async () => {
    mockSessions([
      {
        id: "alpha-chat",
        name: "Alpha chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "Alpha project",
        projectPath: "alpha",
      },
    ]);
    const user = userEvent.setup();
    const { container } = renderRecentChats();

    const projects = await screen.findByRole("region", { name: "Projects" });
    await within(projects).findByRole("link", { name: "Alpha chat" });
    const groups = Array.from(container.querySelectorAll("[data-project-group]"));
    expect(groups.map((group) => group.getAttribute("data-project-group"))).toEqual([
      "project:default",
      "project:alpha",
    ]);
    const defaultGroup = groups[0] as HTMLElement;
    // Nothing to expand, and no empty-state text: the row alone.
    const row = within(defaultGroup).getByRole("button", { name: "default" });
    expect(row.getAttribute("aria-expanded")).toBeNull();
    expect(within(defaultGroup).queryAllByRole("link")).toHaveLength(0);
    expect(defaultGroup.textContent).toBe("default");

    await user.click(
      within(defaultGroup).getByRole("button", { name: "New chat in this project" }),
    );
    expect(screen.getByTestId("location-path").textContent).toBe("/chat");
    expect(screen.getByTestId("location-state").textContent).toBe('{"projectPath":"default"}');
  });

  it("keeps the default project first under archived when it holds no archived chat", async () => {
    localStorage.setItem("rome-recent-chats-status-filter", "archived");
    mockSessions([
      {
        id: "default-live",
        name: "Default live chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
      },
      {
        id: "alpha-old",
        name: "Alpha old chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T11:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "Alpha project",
        projectPath: "alpha",
        archivedAt: "2026-07-09T12:00:00.000Z",
      },
    ]);
    const { container } = renderRecentChats();

    await screen.findByRole("link", { name: "Alpha old chat" });
    expect(screen.queryByText("Default live chat")).toBeNull();
    const groups = Array.from(container.querySelectorAll("[data-project-group]"));
    expect(groups.map((group) => group.getAttribute("data-project-group"))).toEqual([
      "project:default",
      "project:alpha",
    ]);
    expect(
      within(groups[0] as HTMLElement).getByRole("button", { name: "New chat in this project" }),
    ).toBeTruthy();
  });

  it("offers no date grouping and no pins", async () => {
    // Left over from an older list: neither applies any more.
    localStorage.setItem("rome-recent-chats-group-mode", "date");
    localStorage.setItem("rome-recent-chats-pinned-projects", JSON.stringify(["alpha"]));
    mockSessions([
      {
        id: "alpha-chat",
        name: "Alpha chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: new Date().toISOString(),
        lastSeenActivityAt: null,
        unread: false,
        projectName: "Alpha project",
        projectPath: "alpha",
        pinnedAt: "2026-07-09T13:00:00.000Z",
      },
    ]);
    const user = userEvent.setup();
    const { container } = renderRecentChats();

    const projects = await screen.findByRole("region", { name: "Projects" });
    expect(await within(projects).findByRole("link", { name: "Alpha chat" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
    expect(screen.queryByText("Today")).toBeNull();
    expect(screen.queryByRole("button", { name: "Project actions" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "List settings" }));
    expect(screen.queryByRole("menuitem", { name: "Date" })).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(within(projects).getByRole("button", { name: "Chat actions" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent?.replace(/[A-Z]$/, "")),
    ).toEqual(["Rename", "Archive", "Delete"]);
    expect(container.querySelector(".lucide-pin")).toBeNull();
  });

  it("keeps project groups free of location icons while no chat is on a device", async () => {
    mockSessions([
      {
        id: "default-chat",
        name: "Default chat",
        createdAt: "2026-07-02T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
      },
    ]);
    renderRecentChats();
    const defaultGroup = await screen.findByRole("button", { name: "default" });
    expect(defaultGroup.querySelector("[data-location-icon]")).toBeNull();
  });

  it("groups a device-folder chat under its folder, not under its default project", async () => {
    const deviceFolder = {
      deviceId: "dev-1",
      deviceName: "devbox-dev",
      platform: "linux",
      path: "/home/ubuntu/device-folder",
    };
    mockSessions([
      {
        id: "default-chat",
        name: "Default chat",
        createdAt: "2026-07-02T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
      },
      {
        id: "device-chat",
        name: "Device chat",
        createdAt: "2026-07-03T00:00:00.000Z",
        activityAt: "2026-07-09T11:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
        deviceFolder,
      },
    ]);
    const user = userEvent.setup();
    renderRecentChats();

    await screen.findByRole("link", { name: "Default chat" });
    const projectsSection = screen.getByRole("region", { name: "Projects" });
    const defaultGroup = within(projectsSection).getByRole("button", { name: "default" })
      .parentElement?.parentElement as HTMLElement;
    expect(within(defaultGroup).getByRole("link", { name: "Default chat" })).toBeTruthy();
    expect(within(defaultGroup).queryByRole("link", { name: "Device chat" })).toBeNull();

    const folderGroup = within(projectsSection).getByRole("button", {
      name: "device-folder on devbox-dev",
    });
    // The folder icon still shows the open state; a laptop marks another computer.
    expect(folderGroup.querySelector(".lucide-folder-open")).toBeTruthy();
    expect(folderGroup.querySelector(".lucide-laptop")).toBeTruthy();
    expect(folderGroup.textContent).toBe("device-folder");
    const icon = folderGroup.querySelector('[data-location-icon="device"]') as HTMLElement;
    await user.hover(icon);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("devbox-dev");
    expect(tooltip.textContent).toContain("/home/ubuntu/device-folder");
    await user.unhover(icon);
    expect(within(projectsSection).getByRole("link", { name: "Device chat" })).toBeTruthy();

    // With a device chat in the list, Rome's projects mark their location too.
    const defaultButton = within(projectsSection).getByRole("button", { name: "default" });
    const cloud = defaultButton.querySelector('[data-location-icon="rome"]') as HTMLElement;
    expect(cloud.querySelector(".lucide-cloud")).toBeTruthy();
    await user.hover(cloud);
    expect((await screen.findByRole("tooltip")).textContent).toContain("Rome Cloud");
    await user.unhover(cloud);

    await user.click(
      within(projectsSection).getByRole("button", { name: "New chat in this folder" }),
    );
    expect(JSON.parse(screen.getByTestId("location-state").textContent ?? "null")).toEqual({
      deviceFolder: {
        deviceId: "dev-1",
        deviceName: "devbox-dev",
        path: "/home/ubuntu/device-folder",
        home: null,
      },
    });
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

  it("loads project chats in batches of ten", async () => {
    const sessions = Array.from({ length: 25 }, (_, index) => ({
      id: `session-${index + 1}`,
      name: `Session ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 25 - index)).toISOString(),
      activityAt: new Date(Date.UTC(2026, 6, 25 - index)).toISOString(),
      lastSeenActivityAt: null,
      unread: false,
      projectName: "alpha",
      projectPath: "alpha",
    }));
    mockSessions(sessions);
    const user = userEvent.setup();

    renderRecentChats();

    expect(await screen.findByText("Session 4")).toBeTruthy();
    expect(screen.queryByText("Session 5")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load 21 more" }));
    expect(screen.getByText("Session 14")).toBeTruthy();
    expect(screen.queryByText("Session 15")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load 11 more" }));
    expect(screen.getByText("Session 24")).toBeTruthy();
    expect(screen.queryByText("Session 25")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load 1 more" }));
    expect(screen.getByText("Session 25")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Load \d+ more/ })).toBeNull();
  });

  describe("the status filter on the Concierge chats", () => {
    const topic = (id: string, name: string, archivedAt?: string) => ({
      id,
      name,
      agentName: "core:concierge",
      createdAt: "2026-07-01T00:00:00.000Z",
      activityAt: "2026-07-08T10:00:00.000Z",
      lastSeenActivityAt: null,
      unread: false,
      projectName: "default",
      projectPath: "default",
      ...(archivedAt ? { archivedAt } : {}),
    });
    const conciergeSection = () =>
      screen.getByRole("region", { name: "Main chat and topic chats" });

    beforeEach(() => {
      concierge.chatId = "concierge";
      concierge.chats = [
        { id: "concierge", name: "Concierge", main: true, unread: 0 },
        { id: "topic-1", name: "Live topic", main: false, unread: 0 },
      ];
      mockSessions([
        topic("concierge", "Concierge"),
        topic("topic-1", "Live topic"),
        topic("topic-2", "Old topic", "2026-07-08T12:00:00.000Z"),
      ]);
    });

    it("shows the main chat and the active topic chats under active", async () => {
      renderRecentChats();
      await within(conciergeSection()).findByRole("link", { name: "Live topic" });
      expect(within(conciergeSection()).getByRole("link", { name: "Main chat" })).toBeTruthy();
      expect(screen.queryByText("Old topic")).toBeNull();
    });

    it("shows only the archived topic chats under archived, with Unarchive, and never in Projects", async () => {
      localStorage.setItem("rome-recent-chats-status-filter", "archived");
      const user = userEvent.setup();
      renderRecentChats();
      const old = await within(conciergeSection()).findByRole("link", { name: "Old topic" });
      expect(old.getAttribute("href")).toBe("/chat/topic-2");
      expect(screen.queryByRole("link", { name: "Main chat" })).toBeNull();
      expect(screen.queryByText("Live topic")).toBeNull();
      expect(
        within(screen.getByRole("region", { name: "Projects" })).queryByText("Old topic"),
      ).toBeNull();

      await user.click(screen.getByRole("button", { name: "Actions for Old topic" }));
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "Rename",
        "Unarchive chat",
        "Delete",
      ]);
    });

    it("shows a renamed archived topic chat under its new name", async () => {
      localStorage.setItem("rome-recent-chats-status-filter", "archived");
      const user = userEvent.setup();
      renderRecentChats();
      await within(conciergeSection()).findByRole("link", { name: "Old topic" });
      await user.click(screen.getByRole("button", { name: "Actions for Old topic" }));
      await user.click(screen.getByRole("menuitem", { name: "Rename" }));
      const input = await screen.findByRole("textbox", { name: "Chat name" });
      await user.clear(input);
      await user.type(input, "Renamed topic{Enter}");
      expect(
        await within(conciergeSection()).findByRole("link", { name: "Renamed topic" }),
      ).toBeTruthy();
      expect(screen.queryByText("Old topic")).toBeNull();
    });

    it("shows the main chat and every topic chat under all", async () => {
      localStorage.setItem("rome-recent-chats-status-filter", "all");
      renderRecentChats();
      await within(conciergeSection()).findByRole("link", { name: "Old topic" });
      expect(within(conciergeSection()).getByRole("link", { name: "Main chat" })).toBeTruthy();
      expect(within(conciergeSection()).getByRole("link", { name: "Live topic" })).toBeTruthy();
    });
  });

  it("lists the latest five topic chats, then More for the rest", async () => {
    concierge.chatId = "concierge";
    concierge.chats = [
      { id: "concierge", name: "Concierge", main: true, unread: 0 },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `topic-${index + 1}`,
        name: `Topic ${index + 1}`,
        main: false,
        unread: 0,
      })),
    ];
    // The list's activity times decide the order: topic 7 moved last.
    mockSessions(
      concierge.chats.slice(1).map((chat, index) => ({
        id: chat.id,
        name: chat.name,
        agentName: "core:concierge",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: new Date(Date.UTC(2026, 6, 2 + index)).toISOString(),
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
      })) as MockSession[],
    );
    const user = userEvent.setup();
    renderRecentChats();

    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll("[data-concierge-topic]")).map((row) =>
          row.getAttribute("data-concierge-topic"),
        ),
      ).toEqual(["topic-7", "topic-6", "topic-5", "topic-4", "topic-3"]),
    );
    await user.click(screen.getByRole("button", { name: "2 more" }));
    expect(screen.getByRole("link", { name: "Topic 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
  });

  it("updates a topic chat folded under More when a turn in it ends", async () => {
    concierge.chatId = "concierge";
    concierge.fromServer = true;
    const unread: Record<string, number> = {};
    const topics = Array.from({ length: 6 }, (_, index) => ({
      id: `topic-${index + 1}`,
      name: `Topic ${index + 1}`,
      agentName: "core:concierge",
      createdAt: "2026-07-01T00:00:00.000Z",
      // Topic 1 moved first, so it is the sixth and folded under More.
      activityAt: new Date(Date.UTC(2026, 6, 2 + index)).toISOString(),
      lastSeenActivityAt: null,
      unread: false,
      projectName: "default",
      projectPath: "default",
    }));
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/chat/sessions")) return Response.json(topics);
      if (url === "/api/concierge/chats") {
        return Response.json({
          chats: [
            { id: "concierge", name: "Concierge", main: true, unread: 0 },
            ...topics.map((t) => ({
              id: t.id,
              name: t.name,
              main: false,
              unread: unread[t.id] ?? 0,
            })),
          ],
        });
      }
      if (url === "/api/concierge/session") return Response.json({ id: "concierge", unread: 0 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch);
    FakeWebSocket.instances = [];
    const user = userEvent.setup();
    renderRecentChats("/chat", fakeSocketLiveEventsClient());
    await screen.findByRole("button", { name: "1 more" });
    let socket!: FakeWebSocket;
    act(() => {
      socket = acceptLatestSocket();
    });
    // No topic row holds a subscription of its own.
    expect(
      socket.sent.filter((m) =>
        String((m as { topic?: string }).topic).startsWith("chat.session:topic"),
      ),
    ).toEqual([]);

    unread["topic-1"] = 2;
    act(() =>
      socket.receive({
        type: "event",
        topic: "chat.status",
        event: "session_running",
        data: { sessionId: "topic-1", running: false },
      }),
    );
    await user.click(screen.getByRole("button", { name: "1 more" }));
    expect(await screen.findByRole("link", { name: "Topic 1, 2 unread messages" })).toBeTruthy();
  });

  it("keeps the open topic chat in view when it is past the first five", async () => {
    concierge.chatId = "concierge";
    concierge.chats = [
      { id: "concierge", name: "Concierge", main: true, unread: 0 },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `topic-${index + 1}`,
        name: `Topic ${index + 1}`,
        main: false,
        unread: 0,
      })),
    ];
    mockSessions([]);
    // Not in the chat list yet, so the Concierge's own order stands, newest first.
    renderRecentChats("/chat/topic-1");
    expect(await screen.findByRole("link", { name: "Topic 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
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
        ([url]) => String(url) === "/api/chat/sessions?status=archived&scope=mine",
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
    await user.click(await screen.findByRole("button", { name: "Chat actions" }));
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

describe("running mark style", () => {
  const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

  it("turns at an even speed, not in visible ticks", () => {
    expect(css).toMatch(/\.rome-status-spin \{\s*animation: rome-status-spin 1s linear infinite;/);
  });

  it("stands still under reduced motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.rome-status-spin \{\s*animation: none;/);
  });
});
