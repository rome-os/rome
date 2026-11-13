// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { type ChatWorkParts, groupChatWork } from "@rome/api-types/chat-work";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import { chatWorkTopicName } from "@rome/api-types/live-events";
import i18n from "@/i18n";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { acceptLatestSocket, fakeSocketLiveEventsClient } from "@/test/fake-websocket";
import { WorkTab } from "./WorkTab";

const NOW = Date.now();

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
    sourceMessageId: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: status === "ended" ? NOW - 1000 : null,
    archivedAt: null,
    notSynced: false,
    ...extra,
  };
}

let parts: ChatWorkParts;
let requests: Array<{ method: string; url: string; body?: unknown }>;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  requests = [];
  parts = {
    tasks: [
      {
        kind: "task",
        task: task("Pick a hotel", "needs_you", {
          openWait: { kind: "approval", id: "a1", since: NOW },
        }),
        schedule: null,
        check: null,
      },
      {
        kind: "task",
        task: task("Morning brief", "later"),
        schedule: { at: "08:00", days: null },
        check: { id: "run-1", at: NOW + 60 * 60 * 1000, recurring: true },
      },
      { kind: "task", task: task("Old work", "ended"), schedule: null, check: null },
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
        managed: false,
      },
    ],
  };
  rs.stubGlobal(
    "fetch",
    rs.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const body =
        method === "GET" ? { chatId: "concierge", groups: groupChatWork(parts) } : { ok: true };
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

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
        <MemoryRouter>
          <WorkTab chatId="concierge" />
        </MemoryRouter>
      </LiveEventsClientContext.Provider>
    </QueryClientProvider>,
  );
}

const reads = () => requests.filter((request) => request.method === "GET").length;

describe("WorkTab", () => {
  it("shows each group as a titled card, with Ended folded", async () => {
    renderTab();
    const needsYou = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needsYou).getByText("Waiting for your approval")).toBeTruthy();
    const later = screen.getByRole("region", { name: "Later" });
    // A scheduled task carries its repeat mark and its next run on its row.
    expect(within(later).getByLabelText("Repeats")).toBeTruthy();
    expect(within(later).getByText(/Daily at .* · Next run in 1 hr/)).toBeTruthy();
    const own = screen.getByRole("region", { name: "Running on its own" });
    expect(within(own).getByText(/Paused · Last run failed/)).toBeTruthy();

    const ended = screen.getByRole("region", { name: "Ended" });
    expect(within(ended).queryByText("Old work")).toBeNull();
    fireEvent.click(within(ended).getByRole("button", { name: /Ended/ }));
    expect(within(ended).getByText("Old work")).toBeTruthy();
  });

  it("says nothing runs here when the chat has no work", async () => {
    parts = { tasks: [], checks: [], follows: [], routines: [] };
    renderTab();
    expect(await screen.findByText("Nothing runs here yet.")).toBeTruthy();
  });

  it("sends each row's action to the chat's work routes and reads the tab again", async () => {
    renderTab();
    await screen.findByRole("region", { name: "Later" });
    fireEvent.click(screen.getByRole("button", { name: "Skip this run" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Pick a hotel" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume Daily summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Daily summary" }));
    await waitFor(() =>
      expect(requests.filter((request) => request.method !== "GET")).toEqual([
        { method: "DELETE", url: "/api/chats/concierge/work/checks/run-1", body: undefined },
        {
          method: "POST",
          url: "/api/chats/concierge/work/tasks/Pick%20a%20hotel/stop",
          body: undefined,
        },
        { method: "POST", url: "/api/chats/concierge/work/routines/r1/resume", body: undefined },
        { method: "DELETE", url: "/api/chats/concierge/work/routines/r1", body: undefined },
      ]),
    );
    await waitFor(() => expect(reads()).toBeGreaterThan(1));
  });

  it("reads the tab again when the server says its work changed", async () => {
    renderTab();
    await screen.findByRole("region", { name: "Later" });
    const socket = acceptLatestSocket();
    const before = reads();
    socket.receive({
      type: "event",
      topic: chatWorkTopicName("concierge"),
      event: "work_changed",
      data: { chatId: "concierge" },
    });
    await waitFor(() => expect(reads()).toBe(before + 1));
  });
});
