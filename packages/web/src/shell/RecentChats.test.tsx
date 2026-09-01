// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import i18n from "@/i18n";
import { RecentChats } from "./RecentChats";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
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

function renderRecentChats(initialEntry = "/chat", onSearch = () => {}) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <RecentChats onSearch={onSearch} />
      <LocationProbe />
    </MemoryRouter>,
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
  it("keeps search and list settings visible together", async () => {
    mockSessions([]);
    const onSearch = rs.fn();
    const user = userEvent.setup();

    renderRecentChats("/chat", onSearch);

    await screen.findByText("No chats yet");
    const searchButton = screen.getByRole("button", { name: "Search chats" });
    expect(searchButton).toBeTruthy();
    expect(searchButton.getAttribute("title")).toMatch(/^Search chats \((⌘K|Ctrl K)\)$/);
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

  it("names the unread marker for assistive tech without adding a second text weight", async () => {
    mockSessions([
      {
        id: "unread-chat",
        name: "Unread chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: "2026-07-09T09:00:00.000Z",
        unread: true,
        projectName: "alpha",
        projectPath: "alpha",
      },
      {
        id: "read-chat",
        name: "Read chat",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-08T10:00:00.000Z",
        lastSeenActivityAt: "2026-07-08T11:00:00.000Z",
        unread: false,
        projectName: "alpha",
        projectPath: "alpha",
      },
    ]);

    renderRecentChats();

    expect(await screen.findByRole("img", { name: "Unread" })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Unread" })).toHaveLength(1);
    const unreadRow = screen.getByText("Unread chat").closest("[data-chat-row]");
    const readRow = screen.getByText("Read chat").closest("[data-chat-row]");
    expect(unreadRow?.className).toContain("text-ui");
    expect(readRow?.className).toContain("text-ui");
    expect(unreadRow?.className).toContain("h-8");
    expect(unreadRow?.className).not.toContain("font-medium");
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
    expect(container.querySelectorAll(".bg-info")).toHaveLength(1);
  });

  it("hides the Projects heading when nothing is pinned", async () => {
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

    const projectsSection = await screen.findByRole("region", { name: "Projects" });
    expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
    expect(within(projectsSection).getByRole("link", { name: "Regular chat" })).toBeTruthy();
  });

  it("groups by date using activity time instead of created time", async () => {
    localStorage.setItem("rome-recent-chats-group-mode", "date");
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    mockSessions([
      {
        id: "today-activity",
        name: "Today activity",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: "2026-07-09T09:00:00.000Z",
        unread: true,
        projectName: "alpha",
        projectPath: "alpha",
      },
    ]);

    renderRecentChats();

    await act(async () => {
      await rs.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Today activity")).toBeTruthy();
  });

  it("shows pinned projects in a shared Pinned section without pin status icons", async () => {
    localStorage.setItem("rome-recent-chats-pinned-projects", JSON.stringify(["alpha"]));
    mockSessions([
      {
        id: "project-chat",
        name: "Project chat",
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

    const pinnedSection = await screen.findByRole("region", { name: "Pinned" });
    expect(
      await within(pinnedSection).findByRole("button", { name: "Alpha project" }),
    ).toBeTruthy();
    expect(container.querySelector(".lucide-pin")).toBeNull();
    expect(container.querySelector(".lucide-pin-off")).toBeNull();

    await user.click(within(pinnedSection).getByRole("button", { name: "Project actions" }));
    const unpinItem = screen.getByRole("menuitem", { name: "Unpin" });
    expect(unpinItem.querySelector(".lucide-pin-off")).toBeTruthy();
    await user.click(unpinItem);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull());
    expect(
      within(screen.getByRole("region", { name: "Projects" })).getByRole("link", {
        name: "Project chat",
      }),
    ).toBeTruthy();
  });

  it("keeps default chats grouped under the default project", async () => {
    localStorage.setItem("rome-recent-chats-pinned-projects", JSON.stringify(["alpha"]));
    mockSessions([
      {
        id: "pinned-chat",
        name: "Pinned standalone chat",
        createdAt: "2026-07-04T00:00:00.000Z",
        activityAt: "2026-07-09T12:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
        pinnedAt: "2026-07-09T13:00:00.000Z",
      },
      {
        id: "pinned-project-chat",
        name: "Pinned project child",
        createdAt: "2026-07-03T00:00:00.000Z",
        activityAt: "2026-07-09T11:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "Alpha project",
        projectPath: "alpha",
      },
      {
        id: "standalone-chat",
        name: "Standalone chat",
        createdAt: "2026-07-02T00:00:00.000Z",
        activityAt: "2026-07-09T10:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "default",
        projectPath: "default",
      },
      {
        id: "regular-project-chat",
        name: "Regular project child",
        createdAt: "2026-07-01T00:00:00.000Z",
        activityAt: "2026-07-09T09:00:00.000Z",
        lastSeenActivityAt: null,
        unread: false,
        projectName: "Beta project",
        projectPath: "beta",
      },
    ]);
    const user = userEvent.setup();

    renderRecentChats();

    const pinnedSection = await screen.findByRole("region", { name: "Pinned" });
    const projectsSection = screen.getByRole("region", { name: "Projects" });

    expect(
      within(pinnedSection).getByRole("link", { name: "Pinned standalone chat" }),
    ).toBeTruthy();
    const pinnedProjectButton = within(pinnedSection).getByRole("button", {
      name: "Alpha project",
    });
    expect(pinnedProjectButton.querySelector(".lucide-folder-open")).toBeTruthy();
    const pinnedProjectChat = within(pinnedSection).getByRole("link", {
      name: "Pinned project child",
    });
    expect(pinnedProjectChat.classList.contains("pl-4")).toBe(true);
    expect(pinnedProjectChat.classList.contains("pl-12")).toBe(false);
    expect(
      within(pinnedSection).getByRole("button", { name: "New chat in this project" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Chats" })).toBeNull();
    const defaultProjectButton = within(projectsSection).getByRole("button", {
      name: "default",
    });
    expect(defaultProjectButton.querySelector(".lucide-folder-open")).toBeTruthy();
    expect(within(projectsSection).getByRole("link", { name: "Standalone chat" })).toBeTruthy();
    expect(within(projectsSection).getByRole("button", { name: "Beta project" })).toBeTruthy();
    expect(
      within(projectsSection).getByRole("link", { name: "Regular project child" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Alpha project")).toHaveLength(1);

    await user.click(pinnedProjectButton);
    expect(within(pinnedSection).queryByText("Pinned project child")).toBeNull();
    expect(pinnedProjectButton.querySelector(".lucide-folder")).toBeTruthy();
    expect(pinnedProjectButton.querySelector(".lucide-folder-open")).toBeNull();

    await user.click(pinnedProjectButton);
    expect(within(pinnedSection).getByText("Pinned project child")).toBeTruthy();
    expect(pinnedProjectButton.querySelector(".lucide-folder-open")).toBeTruthy();

    await user.click(within(pinnedSection).getByRole("button", { name: "Pinned" }));
    expect(within(pinnedSection).queryByText("Pinned standalone chat")).toBeNull();
    expect(within(pinnedSection).queryByText("Pinned project child")).toBeNull();
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
      spy.mock.calls.some(([url]) => String(url) === "/api/chat/sessions?status=archived"),
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

  it("shows no tooltip when the chat name fits in the row", async () => {
    mockSessions([longNameSession("Short chat")]);
    const user = userEvent.setup();

    renderRecentChats();

    // Untouched jsdom geometry (0/0) is exactly a name that fits.
    await user.hover(await screen.findByText("Short chat"));

    // Outwait the tooltip open delay before concluding nothing appeared.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
