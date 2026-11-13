// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { type TaskListParts, groupTaskList, pageTaskList } from "@rome/api-types/task-list";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import { chatTasksTopicName } from "@rome/api-types/live-events";
import i18n from "@/i18n";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { acceptLatestSocket, fakeSocketLiveEventsClient } from "@/test/fake-websocket";
import { onConciergeJump } from "./concierge-jump";
import { ENDED_PAGE, TaskList, creationAge } from "./TaskList";

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
    state: "next",
    status,
    endReason: status === "ended" ? "done" : null,
    summary: null,
    waitingOn: null,
    dueAt: null,
    rank: null,
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
  cardMessageId: null,
  ...extra,
});

let parts: TaskListParts;
let requests: Array<{ method: string; url: string }>;
let readGate: Promise<void> | null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  requests = [];
  readGate = null;
  parts = {
    tasks: [
      taskItem(
        task("Pick a hotel", "needs_you", {
          openWait: { kind: "approval", id: "a1", since: NOW },
          waitingSince: NOW - HOUR,
        }),
        { cardMessageId: "card-message" },
      ),
      taskItem(task("Review PRs", "active")),
      taskItem(task("Morning brief", "later", { chat: null }), {
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

describe("TaskList", () => {
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

  it("gives every row a title and one line of state and time, with nothing else on the right", async () => {
    renderList();
    await screen.findByRole("region", { name: "Later" });
    expect(
      within(rowOf("Pick a hotel")).getByText("Waiting for your approval · 1 hr ago"),
    ).toBeTruthy();
    expect(within(rowOf("Review PRs")).getByText("Running")).toBeTruthy();
    // A scheduled task's repeat is in its line, with no repeat mark.
    expect(within(rowOf("Morning brief")).getByText(/^Daily at .* · in 1 hr$/)).toBeTruthy();
    expect(within(rowOf("Morning brief")).queryByLabelText("Repeats")).toBeNull();
    expect(within(rowOf("Daily summary")).getByText(/Paused · Last run failed/)).toBeTruthy();
    // Respond and Stop where a card waits; Stop on any task not ended; nothing else.
    const names = (title: string) =>
      within(rowOf(title))
        .queryAllByRole("button")
        .map((button) => button.getAttribute("aria-label"));
    expect(names("Pick a hotel")).toEqual(["Respond to Pick a hotel", "Stop Pick a hotel"]);
    expect(names("Review PRs")).toEqual(["Stop Review PRs"]);
    expect(names("Morning brief")).toEqual(["Stop Morning brief"]);
    expect(names("Daily summary")).toEqual([]);
    // They show on hover and focus only.
    const buttons = within(rowOf("Pick a hotel")).getByRole("button", {
      name: "Respond to Pick a hotel",
    }).parentElement as HTMLElement;
    expect(buttons.className).toContain("opacity-0");
    expect(buttons.className).toContain("group-hover/row:opacity-100");
  });

  it("draws Respond and Stop as icons named by their label and tooltip", async () => {
    renderList();
    await screen.findByRole("region", { name: "Needs you" });
    for (const name of ["Respond to Pick a hotel", "Stop Pick a hotel"]) {
      const button = within(rowOf("Pick a hotel")).getByRole("button", { name });
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg")).toBeTruthy();
    }
    fireEvent.focus(
      within(rowOf("Pick a hotel")).getByRole("button", { name: "Stop Pick a hotel" }),
    );
    // Its tooltip names it; the row says it nowhere else.
    expect((await screen.findAllByText("Stop")).length).toBeGreaterThan(0);
  });

  it("says how old a not-started task is, and when each row was made in its title's tooltip", async () => {
    parts.tasks.push(taskItem(task("Plan a trip", "later", { createdAt: NOW - 3 * 24 * HOUR })));
    renderList();
    await screen.findByRole("region", { name: "Later" });
    expect(within(rowOf("Plan a trip")).getByText("Not started · Created 3 days ago")).toBeTruthy();
    // A scheduled one keeps its schedule line.
    expect(within(rowOf("Morning brief")).getByText(/^Daily at .* · in 1 hr$/)).toBeTruthy();
    fireEvent.focus(screen.getByText("Plan a trip"));
    expect((await screen.findAllByText(/^Created /)).length).toBeGreaterThan(0);
  });

  it("counts a creation's age by calendar day, in the iOS app's words", () => {
    const at = new Date(2026, 10, 13, 9, 0).getTime();
    expect(creationAge(at - 2 * HOUR, at, "en")).toBe("today");
    expect(creationAge(new Date(2026, 10, 12, 23, 0).getTime(), at, "en")).toBe("yesterday");
    expect(creationAge(new Date(2026, 10, 10, 23, 0).getTime(), at, "en")).toBe("3 days ago");
    expect(creationAge(new Date(2026, 10, 10, 23, 0).getTime(), at, "zh-CN")).toBe("3天前");
    expect(creationAge(new Date(2026, 10, 12, 23, 0).getTime(), at, "zh-CN")).toBe("昨天");
    expect(creationAge(at - HOUR, at, "zh-CN")).toBe("今天");
  });

  it("links to a task's chat beside its title only when it has one, and the row itself opens nothing", async () => {
    const jumps: string[] = [];
    const stop = onConciergeJump(async (id) => {
      jumps.push(id);
      return true;
    });
    renderList();
    await screen.findByRole("region", { name: "Later" });
    expect(
      within(rowOf("Review PRs"))
        .getByRole("link", { name: "Open the chat for Review PRs" })
        .getAttribute("href"),
    ).toBe("/chat/chat-Review PRs");
    expect(within(rowOf("Morning brief")).queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByText("Review PRs"));
    expect(jumps).toEqual([]);
    stop();
  });

  it("jumps to the card's message on Respond, pending until it lands", async () => {
    let land!: (landed: boolean) => void;
    const jumps: string[] = [];
    const stop = onConciergeJump(
      (id) =>
        new Promise((resolve) => {
          jumps.push(id);
          land = resolve;
        }),
    );
    renderList();
    await screen.findByRole("region", { name: "Needs you" });
    fireEvent.click(screen.getByRole("button", { name: "Respond to Pick a hotel" }));
    expect(jumps).toEqual(["card-message"]);
    expect(within(rowOf("Pick a hotel")).getByText("Opening…")).toBeTruthy();
    // Pending: both buttons stay shown and take no other press.
    const row = rowOf("Pick a hotel");
    expect(
      within(row)
        .getAllByRole("button")
        .every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(
      within(row).getByRole("button", { name: "Stop Pick a hotel" }).parentElement?.className,
    ).not.toContain("opacity-0");
    await act(async () => land(true));
    expect(
      within(rowOf("Pick a hotel")).getByText("Waiting for your approval · 1 hr ago"),
    ).toBeTruthy();
    stop();
  });

  it("opens the task chat on Respond when no message here shows the card it waits on", async () => {
    parts.tasks[0] = taskItem(parts.tasks[0]!.task, { cardMessageId: null });
    const jumps: string[] = [];
    const stop = onConciergeJump(async (id) => {
      jumps.push(id);
      return true;
    });
    renderList();
    await screen.findByRole("region", { name: "Needs you" });
    fireEvent.click(screen.getByRole("button", { name: "Respond to Pick a hotel" }));
    expect(jumps).toEqual([]);
    expect(screen.getByRole("status", { name: "Location" }).textContent).toBe(
      "/chat/chat-Pick a hotel",
    );
    stop();
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

  it("says nothing runs here when the chat has none", async () => {
    parts = { tasks: [], checks: [], follows: [], routines: [] };
    renderList();
    expect(await screen.findByText("Nothing runs here yet.")).toBeTruthy();
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
