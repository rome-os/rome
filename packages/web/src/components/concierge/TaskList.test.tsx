// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { type TaskListParts, groupTaskList } from "@rome/api-types/task-list";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import { chatTasksTopicName } from "@rome/api-types/live-events";
import i18n from "@/i18n";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { acceptLatestSocket, fakeSocketLiveEventsClient } from "@/test/fake-websocket";
import { onConciergeJump } from "./concierge-jump";
import { ENDED_PAGE, TaskList } from "./TaskList";

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
      const body =
        method === "GET" ? { chatId: "concierge", groups: groupTaskList(parts) } : { ok: true };
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

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
        <MemoryRouter>
          <TaskList chatId="concierge" />
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

  it("shows the newest ended rows first, a page at a time", async () => {
    parts.tasks = Array.from({ length: ENDED_PAGE + 5 }, (_, index) =>
      taskItem(task(`Ended ${index}`, "ended", { completedAt: NOW - index * 1000 })),
    );
    renderList();
    const ended = await screen.findByRole("region", { name: "Ended" });
    fireEvent.click(within(ended).getByRole("button", { name: /Ended/ }));
    expect(within(ended).getAllByRole("listitem")).toHaveLength(ENDED_PAGE + 1);
    expect(within(ended).getByText("Ended 0")).toBeTruthy();
    expect(within(ended).queryByText(`Ended ${ENDED_PAGE}`)).toBeNull();
    fireEvent.click(within(ended).getByRole("button", { name: "Show 5 more" }));
    expect(within(ended).getByText(`Ended ${ENDED_PAGE + 4}`)).toBeTruthy();
    expect(within(ended).queryByRole("button", { name: /Show .* more/ })).toBeNull();
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
