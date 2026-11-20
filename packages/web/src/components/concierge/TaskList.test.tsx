// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { type TaskListParts, groupTaskList, pageTaskList } from "@rome/api-types/task-list";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import { chatTasksTopicName } from "@rome/api-types/live-events";
import i18n from "@/i18n";
import { keyboardFocus } from "@/test/keyboard-focus";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { acceptLatestSocket, fakeSocketLiveEventsClient } from "@/test/fake-websocket";
import { ENDED_PAGE, TaskList, type TaskListView, useChatTaskList } from "./TaskList";

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function task(
  id: string,
  status: NonNullable<ConciergeTaskDto["status"]>,
  extra: Partial<ConciergeTaskDto> = {},
): ConciergeTaskDto {
  return {
    id,
    title: id,
    state: "doing",
    status,
    endReason: status === "ended" ? "done" : null,
    chat: { id: `chat-${id}`, name: id },
    conciergeChat: { id: "concierge", name: "Main chat", main: true },
    sourceMessageId: "source-message",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: status === "ended" ? NOW - 2 * HOUR : null,
    archivedAt: null,
    notSynced: false,
    ...extra,
  };
}

const taskItem = (t: ConciergeTaskDto, extra: Partial<TaskListParts["tasks"][number]> = {}) => ({
  kind: "task" as const,
  task: t,
  schedule: null,
  check: null,
  ...extra,
});

let parts: TaskListParts;
let requests: Array<{ method: string; url: string }>;
let readGate: Promise<void> | null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

/** What `GET /api/concierge/connectors` answers. */
let connectors: object[] = [];

beforeEach(() => {
  connectors = [];
  requests = [];
  readGate = null;
  parts = {
    tasks: [
      taskItem(
        task("Pick a hotel", "needs_you", {
          openWait: { kind: "approval", id: "a1", since: NOW },
          waitingSince: NOW - HOUR,
        }),
      ),
      taskItem(task("Review PRs", "active", { updatedAt: NOW - 25 * 60_000 })),
      taskItem(task("Morning brief", "later"), {
        schedule: { at: "08:00", days: null },
        check: { id: "run-1", at: NOW + HOUR + 30_000, recurring: true },
      }),
      taskItem(task("Old work", "ended")),
    ],
    checks: [],
    follows: [],
    routines: [
      {
        kind: "routine",
        id: "r1",
        name: "Daily summary",
        trigger: { type: "schedule", localTime: "21:00", rrule: "FREQ=DAILY", date: null },
        enabled: false,
        nextRunAt: null,
        lastRun: { status: "error", firedAt: NOW },
      },
      {
        kind: "routine",
        id: "r2",
        name: "Summarize Rome releases",
        trigger: { type: "schedule", localTime: "10:00", rrule: "FREQ=DAILY", date: null },
        enabled: true,
        nextRunAt: NOW + HOUR,
        lastRun: null,
        fromTask: { id: "t-releases", title: "Rome releases" },
      },
    ],
  };
  rs.stubGlobal(
    "fetch",
    rs.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url: String(input) });
      if (method === "GET" && readGate) await readGate;
      const endedBefore = new URL(String(input), "http://rome.test").searchParams.get(
        "endedBefore",
      );
      if (String(input) === "/api/concierge/connectors") {
        return new Response(JSON.stringify({ connectors, rules: {} }), { status: 200 });
      }
      const body =
        method === "GET"
          ? {
              chatId: "concierge",
              groups: pageTaskList(groupTaskList(parts), endedBefore ?? undefined),
            }
          : { ok: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

function Where() {
  return <output aria-label="Location">{useLocation().pathname}</output>;
}

function renderList(view: TaskListView = "tasks") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
        <MemoryRouter>
          <TaskList chatId="concierge" view={view} />
          <Where />
        </MemoryRouter>
      </LiveEventsClientContext.Provider>
    </QueryClientProvider>,
  );
}

const reads = () => requests.filter((request) => request.method === "GET").length;
const rowOf = (title: string) => screen.getByText(title).closest("li") as HTMLElement;

describe("TaskList", () => {
  it("dims a follow as unavailable when the connector list says its service cannot deliver", async () => {
    const follow = (target: string) => ({
      kind: "follow" as const,
      source: "github",
      label: "github",
      target,
      state: "active" as const,
      digestTimes: [],
    });
    parts = {
      tasks: [],
      checks: [],
      follows: [follow("acme/up"), follow("acme/down")],
      routines: [],
    };
    connectors = [
      {
        service: "github",
        label: "GitHub",
        capabilities: {
          watch: {
            state: "unlocked",
            follows: [
              { target: "acme/up", state: "active" },
              { target: "acme/down", state: "unavailable" },
            ],
          },
        },
      },
    ];
    renderList("routines");

    await waitFor(() => expect(within(rowOf("acme/down")).getByText(/Not available/)).toBeTruthy());
    expect(within(rowOf("acme/up")).queryByText(/Not available/)).toBeNull();
    expect(within(rowOf("acme/up")).getByText(/GitHub/)).toBeTruthy();
    expect(requests.filter((r) => r.url === "/api/concierge/connectors")).toHaveLength(1);
  });

  it("reads the connector list again when a follow changes, and not for any other change", async () => {
    parts = {
      tasks: [],
      checks: [],
      follows: [
        {
          kind: "follow",
          source: "github",
          label: "GitHub",
          target: "acme/up",
          state: "active",
          digestTimes: [],
        },
      ],
      routines: [],
    };
    connectors = [
      {
        service: "github",
        label: "GitHub",
        capabilities: { watch: { state: "unlocked", follows: [] } },
      },
    ];
    renderList("routines");
    await screen.findByText("acme/up");
    const connectorReads = () =>
      requests.filter((r) => r.url === "/api/concierge/connectors").length;
    await waitFor(() => expect(connectorReads()).toBe(1));
    const socket = acceptLatestSocket();
    const changed = (data: Record<string, unknown>) =>
      socket.receive({
        type: "event",
        topic: chatTasksTopicName("concierge"),
        event: "tasks_changed",
        data: { chatId: "concierge", ...data },
      });
    const listReads = () =>
      requests.filter((r) => r.method === "GET" && r.url.startsWith("/api/chats/")).length;
    changed({});
    await waitFor(() => expect(listReads()).toBe(2));
    expect(connectorReads()).toBe(1);
    changed({ follows: true });
    await waitFor(() => expect(connectorReads()).toBe(2));
  });

  it("shows placeholder rows while the first read is on its way", async () => {
    let open!: () => void;
    readGate = new Promise((resolve) => {
      open = resolve;
    });
    renderList();
    expect(screen.getByRole("status", { name: "Loading tasks" })).toBeTruthy();
    await act(async () => open());
    expect(await screen.findByRole("region", { name: "Needs you" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading tasks" })).toBeNull();
  });

  it("lists only the task chats in Tasks, by status, and the rest in Routines", async () => {
    parts.checks = [
      {
        kind: "check",
        check: {
          id: "c1",
          name: "Remind me at 3",
          at: NOW + 40 * 60_000,
          waitingFor: null,
          taskId: null,
        },
      },
    ];
    renderList();
    await screen.findByRole("region", { name: "Later" });
    // Task chats grouped by status, and nothing that is no task chat, with no tabs.
    expect(screen.queryByRole("radio")).toBeNull();
    for (const group of ["Needs you", "Active", "Later"]) {
      expect(screen.getByRole("region", { name: group })).toBeTruthy();
    }
    expect(screen.getByText("Pick a hotel")).toBeTruthy();
    expect(screen.queryByText("Daily summary")).toBeNull();
    expect(screen.queryByText("Remind me at 3")).toBeNull();
    expect(screen.queryByRole("region", { name: "Routines" })).toBeNull();

    cleanup();
    renderList("routines");
    const own = await screen.findByRole("region", { name: "Routines" });
    // Routines and one-off reminders in one list, with no groups, and no task chat.
    expect(within(own).getByText("Daily summary")).toBeTruthy();
    expect(within(own).getByText("Summarize Rome releases")).toBeTruthy();
    expect(within(own).getByText("Remind me at 3")).toBeTruthy();
    expect(screen.queryByText("Pick a hotel")).toBeNull();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    // The soonest first: the reminder in 40 minutes, then the routine in an hour.
    expect(
      within(own)
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".truncate")?.textContent ?? ""),
    ).toEqual(["Remind me at 3", "Summarize Rome releases", "Daily summary"]);
  });

  it("says a task chat needs its owner for the header's Tasks dot, and not otherwise", async () => {
    const Dot = () => (
      <output aria-label="Needs you">{String(useChatTaskList("concierge").needsYou)}</output>
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = () => (
      <QueryClientProvider client={client}>
        <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
          <Dot />
        </LiveEventsClientContext.Provider>
      </QueryClientProvider>
    );
    render(view());
    await waitFor(() => expect(screen.getByLabelText("Needs you").textContent).toBe("true"));
    cleanup();

    parts.tasks = parts.tasks.filter((item) => item.task.status !== "needs_you");
    client.clear();
    render(view());
    await waitFor(() => expect(requests.length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByLabelText("Needs you").textContent).toBe("false"));
  });

  it("gives every task row its name and one line of state and time, with Stop only on the right", async () => {
    renderList();
    await screen.findByRole("region", { name: "Later" });
    expect(
      within(rowOf("Pick a hotel")).getByText("Waiting for your approval · 1 hr ago"),
    ).toBeTruthy();
    // Active, with how long ago it began.
    expect(within(rowOf("Review PRs")).getByText("Active · 25 min ago")).toBeTruthy();
    // A scheduled task's repeat is in its line, with no repeat mark.
    expect(
      within(rowOf("Morning brief")).getByText(/^Daily at .* · in \d+ (hr|min)$/),
    ).toBeTruthy();
    expect(within(rowOf("Morning brief")).queryByLabelText("Repeats")).toBeNull();
    // Stop on any task not ended, and nothing else: no Respond.
    const names = (title: string) =>
      within(rowOf(title))
        .queryAllByRole("button")
        .map((button) => button.getAttribute("aria-label"));
    expect(names("Pick a hotel")).toEqual(["Stop Pick a hotel"]);
    expect(names("Review PRs")).toEqual(["Stop Review PRs"]);
    expect(names("Morning brief")).toEqual(["Stop Morning brief"]);
    // They show on hover and focus only.
    const buttons = within(rowOf("Pick a hotel")).getByRole("button", {
      name: "Stop Pick a hotel",
    }).parentElement as HTMLElement;
    expect(buttons.className).toContain("opacity-0");
    expect(buttons.className).toContain("group-hover/row:opacity-100");
    // The Routines list has no groups, and no buttons on its rows.
    cleanup();
    renderList("routines");
    await screen.findByText("Daily summary");
    expect(within(rowOf("Daily summary")).getByText(/Paused · Last run failed/)).toBeTruthy();
    expect(within(rowOf("Daily summary")).queryAllByRole("button")).toEqual([]);
    expect(
      within(rowOf("Summarize Rome releases")).getByText(
        /^Daily at .* · in \d+ (hr|min) · From Rome releases$/,
      ),
    ).toBeTruthy();
  });

  it("opens the task chat when its row is pressed, and Stop is its only action", async () => {
    renderList();
    await screen.findByRole("region", { name: "Later" });
    const row = rowOf("Review PRs");
    const link = within(row).getByRole("link", { name: "Review PRs" });
    expect(link.getAttribute("href")).toBe("/chat/chat-Review%20PRs");
    // The link covers the row: its box is stretched over it.
    expect(link.className).toContain("after:absolute");
    fireEvent.click(link);
    expect(screen.getByRole("status", { name: "Location" }).textContent).toBe(
      "/chat/chat-Review%20PRs",
    );
    // A task chat's name is its row's: one name.
    expect(within(row).queryByRole("link", { name: /Open the chat/ })).toBeNull();
    // Stop is an icon named by its label and tooltip.
    const stop = within(row).getByRole("button", { name: "Stop Review PRs" });
    expect(stop.textContent).toBe("");
    expect(stop.querySelector("svg")).toBeTruthy();
    keyboardFocus(stop);
    expect((await screen.findAllByText("Stop")).length).toBeGreaterThan(0);
  });

  it("marks each task row with the status glyph it shares with a task link", async () => {
    parts.tasks.push(
      taskItem(task("Stopped one", "ended", { endReason: "stopped" })),
      taskItem(task("Failed one", "ended", { endReason: "failed" })),
    );
    renderList();
    await screen.findByRole("region", { name: "Ended" });
    fireEvent.click(screen.getByRole("button", { name: /^Ended/ }));
    const glyph = (title: string) => rowOf(title).querySelector("svg")?.getAttribute("class") ?? "";
    expect(glyph("Pick a hotel")).toContain("lucide-circle-alert");
    expect(rowOf("Review PRs").querySelector(".rome-status-spin")).toBeTruthy();
    expect(glyph("Morning brief")).toContain("lucide-clock");
    expect(glyph("Old work")).toContain("lucide-circle-check");
    expect(glyph("Failed one")).toContain("lucide-circle-x");
    expect(glyph("Stopped one")).toContain("lucide-circle-stop");
    // The colours agree with the task link's: done green, failed red, the rest quiet.
    expect(glyph("Pick a hotel")).toContain("text-warning/80");
    expect(glyph("Old work")).toContain("text-success/80");
    expect(glyph("Failed one")).toContain("text-destructive/80");
    expect(glyph("Stopped one")).toContain("text-subtle-foreground");
  });

  it("stops an active task at once, pending until the task is read as ended", async () => {
    renderList();
    await screen.findByRole("region", { name: "Active" });
    fireEvent.click(screen.getByRole("button", { name: "Stop Review PRs" }));
    // Pending before any answer comes back.
    expect(within(rowOf("Review PRs")).getByText("Stopping…")).toBeTruthy();
    expect(
      requests.filter((request) => request.method === "POST").map((request) => request.url),
    ).toEqual(["/api/chats/concierge/tasks/Review%20PRs/stop"]);
    // Still active on the next read: still pending.
    await waitFor(() => expect(reads()).toBe(2));
    expect(within(rowOf("Review PRs")).getByText("Stopping…")).toBeTruthy();
    // Ended on a later read: it lets go.
    parts.tasks[1] = taskItem(task("Review PRs", "ended", { endReason: "stopped" }));
    const socket = acceptLatestSocket();
    socket.receive({
      type: "event",
      topic: chatTasksTopicName("concierge"),
      event: "tasks_changed",
      data: { chatId: "concierge" },
    });
    await waitFor(() => expect(screen.queryByText("Stopping…")).toBeNull());
  });

  it("stops a scheduled task between runs, pending until it ends", async () => {
    renderList();
    await screen.findByRole("region", { name: "Later" });
    fireEvent.click(screen.getByRole("button", { name: "Stop Morning brief" }));
    expect(within(rowOf("Morning brief")).getByText("Stopping…")).toBeTruthy();
    expect(
      requests.filter((request) => request.method === "POST").map((request) => request.url),
    ).toEqual(["/api/chats/concierge/tasks/Morning%20brief/stop"]);
  });

  it("reads the newest ended rows first, and older ones a page at a time from the server", async () => {
    parts.tasks = Array.from({ length: ENDED_PAGE + 5 }, (_, index) =>
      taskItem(task(`Ended ${index}`, "ended", { completedAt: NOW - index * 1000 })),
    );
    renderList();
    const ended = await screen.findByRole("region", { name: "Ended" });
    // The heading counts every ended row, though one page was read.
    fireEvent.click(within(ended).getByRole("button", { name: `Ended ${ENDED_PAGE + 5}` }));
    expect(within(ended).getAllByRole("listitem")).toHaveLength(ENDED_PAGE + 1);
    expect(within(ended).getByText("Ended 0")).toBeTruthy();
    expect(within(ended).queryByText(`Ended ${ENDED_PAGE}`)).toBeNull();
    fireEvent.click(within(ended).getByRole("button", { name: "Show 5 more" }));
    expect(await within(ended).findByText(`Ended ${ENDED_PAGE + 4}`)).toBeTruthy();
    expect(within(ended).queryByRole("button", { name: /Show .* more/ })).toBeNull();
    expect(requests.map((request) => request.url)).toContain(
      `/api/chats/concierge/tasks?endedBefore=${encodeURIComponent(`${NOW - (ENDED_PAGE - 1) * 1000}_Ended ${ENDED_PAGE - 1}`)}`,
    );
  });

  it("goes back to the first page when the list reads again, so no ended row is lost or shown twice", async () => {
    parts.tasks = Array.from({ length: ENDED_PAGE + 1 }, (_, index) =>
      taskItem(task(`Ended ${index}`, "ended", { completedAt: NOW - (index + 1) * 1000 })),
    );
    renderList();
    const ended = await screen.findByRole("region", { name: "Ended" });
    fireEvent.click(within(ended).getByRole("button", { name: `Ended ${ENDED_PAGE + 1}` }));
    fireEvent.click(within(ended).getByRole("button", { name: "Show 1 more" }));
    expect(await within(ended).findByText(`Ended ${ENDED_PAGE}`)).toBeTruthy();
    // Another task ends: the old twentieth row leaves the first page.
    parts.tasks.push(taskItem(task("Just ended", "ended", { completedAt: NOW })));
    acceptLatestSocket().receive({
      type: "event",
      topic: chatTasksTopicName("concierge"),
      event: "tasks_changed",
      data: { chatId: "concierge" },
    });
    await within(ended).findByText("Just ended");
    const titles = () =>
      within(ended)
        .getAllByRole("listitem")
        .map((item) => item.textContent ?? "");
    await waitFor(() => expect(titles()).toHaveLength(ENDED_PAGE + 1));
    expect(within(ended).queryByText(`Ended ${ENDED_PAGE}`)).toBeNull();
    // Show more brings the rest back, each once.
    fireEvent.click(within(ended).getByRole("button", { name: "Show 2 more" }));
    expect(await within(ended).findByText(`Ended ${ENDED_PAGE}`)).toBeTruthy();
    expect(within(ended).getAllByText(`Ended ${ENDED_PAGE - 1}`)).toHaveLength(1);
    expect(within(ended).getAllByText(`Ended ${ENDED_PAGE}`)).toHaveLength(1);
  });

  it("keeps the older ended rows it read when a re-read leaves the ended rows as they were", async () => {
    parts.tasks = Array.from({ length: ENDED_PAGE + 1 }, (_, index) =>
      taskItem(task(`Ended ${index}`, "ended", { completedAt: NOW - (index + 1) * 1000 })),
    );
    renderList();
    const ended = await screen.findByRole("region", { name: "Ended" });
    fireEvent.click(within(ended).getByRole("button", { name: `Ended ${ENDED_PAGE + 1}` }));
    fireEvent.click(within(ended).getByRole("button", { name: "Show 1 more" }));
    expect(await within(ended).findByText(`Ended ${ENDED_PAGE}`)).toBeTruthy();
    const before = reads();
    // Something else in the chat changed, as a window refocus or a running task would.
    acceptLatestSocket().receive({
      type: "event",
      topic: chatTasksTopicName("concierge"),
      event: "tasks_changed",
      data: { chatId: "concierge" },
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(ended).getByText(`Ended ${ENDED_PAGE}`)).toBeTruthy();
  });

  it("keeps the older ended rows it read when a re-read changes a row but moves none", async () => {
    parts.tasks = Array.from({ length: ENDED_PAGE + 1 }, (_, index) =>
      taskItem(task(`Ended ${index}`, "ended", { completedAt: NOW - (index + 1) * 1000 })),
    );
    renderList();
    const ended = await screen.findByRole("region", { name: "Ended" });
    fireEvent.click(within(ended).getByRole("button", { name: `Ended ${ENDED_PAGE + 1}` }));
    fireEvent.click(within(ended).getByRole("button", { name: "Show 1 more" }));
    expect(await within(ended).findByText(`Ended ${ENDED_PAGE}`)).toBeTruthy();
    // The newest ended task is renamed: same row, same place.
    const [first] = parts.tasks;
    if (first?.kind === "task") first.task = { ...first.task, title: "Renamed" };
    acceptLatestSocket().receive({
      type: "event",
      topic: chatTasksTopicName("concierge"),
      event: "tasks_changed",
      data: { chatId: "concierge" },
    });
    await within(ended).findByText("Renamed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(ended).getByText(`Ended ${ENDED_PAGE}`)).toBeTruthy();
  });

  it("says so when the chat has no task chat and no routines", async () => {
    parts = { tasks: [], checks: [], follows: [], routines: [] };
    renderList();
    expect(await screen.findByText("No tasks yet.")).toBeTruthy();
    cleanup();
    renderList("routines");
    expect(await screen.findByText("No routines yet.")).toBeTruthy();
  });

  it("reads the list again when the server says it changed", async () => {
    renderList();
    await screen.findByRole("region", { name: "Later" });
    const socket = acceptLatestSocket();
    const before = reads();
    socket.receive({
      type: "event",
      topic: chatTasksTopicName("concierge"),
      event: "tasks_changed",
      data: { chatId: "concierge" },
    });
    await waitFor(() => expect(reads()).toBe(before + 1));
  });
});
