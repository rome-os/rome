// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import {
  type TaskListParts,
  groupTaskList,
  groupTaskPanel,
  pageTaskList,
} from "@rome/api-types/task-list";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import { chatTasksTopicName } from "@rome/api-types/live-events";
import i18n from "@/i18n";
import { keyboardFocus } from "@/test/keyboard-focus";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { acceptLatestSocket, fakeSocketLiveEventsClient } from "@/test/fake-websocket";
import { ENDED_PAGE, TaskList, useChatTaskList } from "./TaskList";

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
      const query = new URL(String(input), "http://rome.test").searchParams;
      const endedBefore = query.get("endedBefore");
      const group = query.get("grouping") === "panel" ? groupTaskPanel : groupTaskList;
      if (String(input) === "/api/concierge/connectors") {
        return new Response(JSON.stringify({ connectors, rules: {} }), { status: 200 });
      }
      const body =
        method === "GET"
          ? {
              chatId: "concierge",
              groups: pageTaskList(group(parts), endedBefore ?? undefined),
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

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
        <MemoryRouter>
          <TaskList chatId="concierge" />
          <Where />
        </MemoryRouter>
      </LiveEventsClientContext.Provider>
    </QueryClientProvider>,
  );
}

const reads = () => requests.filter((request) => request.method === "GET").length;
const rowOf = (title: string) => screen.getByText(title).closest("li") as HTMLElement;
const posts = () =>
  requests
    .filter((request) => request.method !== "GET")
    .map((request) => `${request.method} ${request.url}`);
/** Opens row `title`'s ⋯ menu, as a keyboard does, and answers its item names. */
async function openMenu(title: string): Promise<string[]> {
  fireEvent.keyDown(
    within(rowOf(title)).getByRole("button", { name: `More actions for ${title}` }),
    {
      key: "Enter",
    },
  );
  return (await screen.findAllByRole("menuitem")).map((item) => item.textContent ?? "");
}
const choose = (name: string) => fireEvent.click(screen.getByRole("menuitem", { name }));

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
    renderList();

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
    renderList();
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

  it("lists every kind in one list of groups, with no tabs, and asks for the panel's grouping", async () => {
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
    await screen.findByRole("region", { name: "Scheduled" });
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    const titles = (group: string) =>
      within(screen.getByRole("region", { name: group }))
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".truncate")?.textContent ?? "");
    expect(
      screen.getAllByRole("region").map((region) => region.getAttribute("aria-label")),
    ).toEqual(["Needs you", "Active", "Later", "Scheduled", "Ended"]);
    expect(titles("Needs you")).toEqual(["Pick a hotel"]);
    expect(titles("Active")).toEqual(["Review PRs"]);
    expect(titles("Later")).toEqual(["Remind me at 3"]);
    // The soonest first, a paused routine with no next time last.
    expect(titles("Scheduled")).toEqual([
      "Summarize Rome releases",
      "Morning brief",
      "Daily summary",
    ]);
    expect(requests[0]?.url).toBe("/api/chats/concierge/tasks?grouping=panel");
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

  it("gives every row its name and one line of state and time, with its actions in a ⋯ menu", async () => {
    parts.follows = [
      {
        kind: "follow",
        source: "github",
        label: "GitHub",
        target: "rome-os/rome",
        state: "active",
        digestTimes: ["09:00", "18:00"],
        nextAt: new Date(2026, 10, 20, 18, 0).getTime(),
      },
    ];
    renderList();
    await screen.findByRole("region", { name: "Scheduled" });
    expect(
      within(rowOf("Pick a hotel")).getByText("Waiting for your approval · 1 hr ago"),
    ).toBeTruthy();
    expect(within(rowOf("Review PRs")).getByText("Active · 25 min ago")).toBeTruthy();
    // A scheduled task's repeat is in its line, with no repeat mark.
    expect(
      within(rowOf("Morning brief")).getByText(/^Daily at .* · in \d+ (hr|min)$/),
    ).toBeTruthy();
    expect(within(rowOf("Daily summary")).getByText(/Paused · Last run failed/)).toBeTruthy();
    expect(
      within(rowOf("Summarize Rome releases")).getByText(
        /^Daily at .* · in \d+ (hr|min) · From Rome releases$/,
      ),
    ).toBeTruthy();
    expect(
      within(rowOf("rome-os/rome")).getByText(
        "GitHub · Digest daily at 9:00 AM, 6:00 PM · next 6:00 PM",
      ),
    ).toBeTruthy();
    // One ⋯ button on the right, shown on hover and focus only.
    const more = within(rowOf("Pick a hotel")).getByRole("button");
    expect(more.getAttribute("aria-label")).toBe("More actions for Pick a hotel");
    expect(more.className).toContain("opacity-0");
    expect(more.className).toContain("group-hover/row:opacity-100");
    // An ended task has none.
    fireEvent.click(screen.getByRole("button", { name: /^Ended/ }));
    expect(within(rowOf("Old work")).queryAllByRole("button")).toEqual([]);
  });

  it("offers each kind only its own actions", async () => {
    parts.checks = [
      {
        kind: "check",
        check: { id: "c1", name: "Remind me", at: NOW + HOUR, waitingFor: null, taskId: null },
      },
    ];
    parts.follows = [
      {
        kind: "follow",
        source: "github",
        label: "GitHub",
        target: "rome-os/rome",
        state: "active",
        digestTimes: [],
      },
    ];
    renderList();
    await screen.findByRole("region", { name: "Scheduled" });
    const menus: Record<string, string[]> = {};
    for (const title of [
      "Review PRs",
      "Morning brief",
      "Remind me",
      "rome-os/rome",
      "Daily summary",
      "Summarize Rome releases",
    ]) {
      menus[title] = await openMenu(title);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
    expect(menus).toEqual({
      "Review PRs": ["Stop"],
      "Morning brief": ["Stop"],
      "Remind me": ["Cancel"],
      "rome-os/rome": ["Unfollow"],
      "Daily summary": ["Resume", "Delete"],
      "Summarize Rome releases": ["Pause", "Delete"],
    });
  });

  it("opens the task chat when its row is pressed, and nothing for a row that is no task chat", async () => {
    renderList();
    await screen.findByRole("region", { name: "Active" });
    const row = rowOf("Review PRs");
    const link = within(row).getByRole("link", { name: "Review PRs" });
    expect(link.getAttribute("href")).toBe("/chat/chat-Review%20PRs");
    // The link covers the row: its box is stretched over it.
    expect(link.className).toContain("after:absolute");
    fireEvent.click(link);
    expect(screen.getByRole("status", { name: "Location" }).textContent).toBe(
      "/chat/chat-Review%20PRs",
    );
    expect(within(rowOf("Daily summary")).queryByRole("link")).toBeNull();
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
    await openMenu("Review PRs");
    choose("Stop");
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
    await screen.findByRole("region", { name: "Scheduled" });
    await openMenu("Morning brief");
    choose("Stop");
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
      `/api/chats/concierge/tasks?grouping=panel&endedBefore=${encodeURIComponent(`${NOW - (ENDED_PAGE - 1) * 1000}_Ended ${ENDED_PAGE - 1}`)}`,
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

  it("says so when the chat has nothing to list", async () => {
    parts = { tasks: [], checks: [], follows: [], routines: [] };
    renderList();
    expect(await screen.findByText("No tasks yet.")).toBeTruthy();
  });

  it("cancels a reminder at once, and unfollows once confirmed, each pending until the list reads again", async () => {
    parts.checks = [
      {
        kind: "check",
        check: { id: "c 1", name: "Remind me", at: NOW + HOUR, waitingFor: null, taskId: null },
      },
    ];
    parts.follows = [
      {
        kind: "follow",
        source: "github",
        label: "GitHub",
        target: "rome-os/rome",
        state: "active",
        digestTimes: [],
      },
    ];
    let open!: () => void;
    renderList();
    await screen.findByRole("region", { name: "Later" });
    readGate = new Promise((resolve) => {
      open = resolve;
    });
    await openMenu("Remind me");
    choose("Cancel");
    expect(within(rowOf("Remind me")).getByText("Cancelling…")).toBeTruthy();
    expect(within(rowOf("Remind me")).getByRole("button").hasAttribute("disabled")).toBe(true);
    parts.checks = [];
    await act(async () => open());
    await waitFor(() => expect(screen.queryByText("Remind me")).toBeNull());
    readGate = null;
    await openMenu("rome-os/rome");
    choose("Unfollow");
    // Unfollow asks first: nothing is sent until it is confirmed.
    const dialog = await screen.findByRole("dialog", { name: "Unfollow rome-os/rome?" });
    expect(posts()).toEqual(["POST /api/chats/concierge/tasks/checks/c%201/cancel"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Unfollow" }));
    expect(within(rowOf("rome-os/rome")).getByText("Unfollowing…")).toBeTruthy();
    expect(posts()).toEqual([
      "POST /api/chats/concierge/tasks/checks/c%201/cancel",
      "POST /api/chats/concierge/tasks/follows/unfollow",
    ]);
    const unfollow = rs.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(JSON.parse(String(unfollow?.body))).toEqual({
      source: "github",
      target: "rome-os/rome",
    });
    await waitFor(() => expect(screen.queryByText("Unfollowing…")).toBeNull());
  });

  it("pauses and resumes a routine at once, and deletes one only once confirmed", async () => {
    renderList();
    await screen.findByRole("region", { name: "Scheduled" });
    await openMenu("Summarize Rome releases");
    choose("Pause");
    expect(within(rowOf("Summarize Rome releases")).getByText("Pausing…")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Pausing…")).toBeNull());
    await openMenu("Daily summary");
    choose("Resume");
    await waitFor(() => expect(screen.queryByText("Resuming…")).toBeNull());

    await openMenu("Daily summary");
    choose("Delete");
    // Delete asks first, and nothing is sent until it is confirmed.
    const dialog = await screen.findByRole("dialog", { name: "Delete “Daily summary”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts()).toEqual([
      "POST /api/chats/concierge/tasks/routines/r2/pause",
      "POST /api/chats/concierge/tasks/routines/r1/resume",
    ]);
    await openMenu("Daily summary");
    choose("Delete");
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }),
    );
    expect(within(rowOf("Daily summary")).getByText("Deleting…")).toBeTruthy();
    expect(posts().at(-1)).toBe("DELETE /api/chats/concierge/tasks/routines/r1");
  });

  it("acts on no menu item a press did not start on, such as the release of the press that opened the menu", async () => {
    parts.follows = [
      {
        kind: "follow",
        source: "github",
        label: "GitHub",
        target: "rome-os/rome",
        state: "active",
        digestTimes: [],
      },
    ];
    renderList();
    await screen.findByRole("region", { name: "Scheduled" });
    for (const [title, item] of [
      ["rome-os/rome", "Unfollow"],
      ["Daily summary", "Delete"],
      ["Summarize Rome releases", "Pause"],
      ["Review PRs", "Stop"],
    ] as const) {
      await openMenu(title);
      // A release that lands on the item with no press on it, as when the
      // menu opens under the pointer, selects nothing.
      fireEvent.pointerUp(screen.getByRole("menuitem", { name: item }), {
        button: 0,
        pointerType: "mouse",
      });
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts()).toEqual([]);
    // A press that starts and ends on the item acts.
    await openMenu("Summarize Rome releases");
    const pause = screen.getByRole("menuitem", { name: "Pause" });
    fireEvent.pointerDown(pause, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(pause, { button: 0, pointerType: "mouse" });
    fireEvent.click(pause);
    expect(posts()).toEqual(["POST /api/chats/concierge/tasks/routines/r2/pause"]);
  });

  it("lets go of a pending row and says why when its action fails", async () => {
    renderList();
    await screen.findByRole("region", { name: "Scheduled" });
    rs.mocked(fetch).mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: "Nope" }), { status: 500 }),
    );
    await openMenu("Summarize Rome releases");
    choose("Pause");
    await waitFor(() => expect(screen.queryByText("Pausing…")).toBeNull());
    expect(within(rowOf("Summarize Rome releases")).getByText(/^Daily at/)).toBeTruthy();
  });

  it("reads the list again when the server says it changed", async () => {
    renderList();
    await screen.findByRole("region", { name: "Scheduled" });
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
