// @rstest-environment jsdom
import { Activity } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ConciergeTaskDto, ConciergeTaskState } from "@rome/api-types/concierge";
import i18n from "@/i18n";
import { ToolTasksContext, type ToolTasksHost } from "@/pages/free/tool-tasks";
import { ConciergeTasksPill } from "./ConciergeTasksPill";
import { resetPending } from "./task-pending";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import {
  acceptLatestSocket,
  FakeWebSocket,
  fakeSocketLiveEventsClient,
} from "@/test/fake-websocket";

let seq = 0;
const row = (
  state: ConciergeTaskState,
  extra: Partial<ConciergeTaskDto> = {},
): ConciergeTaskDto => ({
  id: `task-${++seq}`,
  title: `Task ${seq}`,
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
  ...extra,
});

const server = { tasks: [] as ConciergeTaskDto[] };

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  seq = 0;
  server.tasks = [];
  resetPending();
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) =>
    String(input).startsWith("/api/concierge/tasks")
      ? new Response(JSON.stringify({ tasks: server.tasks }), {
          headers: { "content-type": "application/json" },
        })
      : new Response("not found", { status: 404 })) as typeof fetch);
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function host(overrides: Partial<ToolTasksHost> = {}): ToolTasksHost {
  return { active: false, compact: false, show: rs.fn(), hide: rs.fn(), ...overrides };
}

function renderPill(pane: ToolTasksHost | null = host()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConciergeTasksPill />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    pane ? <ToolTasksContext.Provider value={pane}>{tree}</ToolTasksContext.Provider> : tree,
  );
}

describe("ConciergeTasksPill", () => {
  it("shows a quiet icon when nothing is running or waiting", async () => {
    server.tasks = [row("next"), row("watching"), row("done")];
    renderPill();
    const pill = await screen.findByRole("button", { name: "Tasks" });
    await waitFor(() => expect(pill.getAttribute("data-state")).toBe("idle"));
    expect(pill.textContent).toBe("");
    expect(pill.querySelector("svg")).not.toBeNull();
  });

  it("shows the Doing count when nothing needs the guardian", async () => {
    server.tasks = [row("doing"), row("doing"), row("next")];
    renderPill();
    const pill = await screen.findByRole("button", { name: "Tasks, 2 in progress" });
    expect(pill.getAttribute("data-state")).toBe("doing");
    expect(pill.textContent).toBe("2");
    expect(pill.className).not.toContain("bg-warning-bg");
  });

  it("shows the Needs you count in warning colour, ahead of Doing", async () => {
    server.tasks = [row("needs_user"), row("doing"), row("doing")];
    renderPill();
    const pill = await screen.findByRole("button", { name: "Tasks, 1 needs you" });
    expect(pill.getAttribute("data-state")).toBe("needsYou");
    expect(pill.textContent).toBe("1");
    expect(pill.className).toContain("bg-warning-bg");
  });

  it("is a small inline pill with a 44px hit area around it, not a control-sized button", async () => {
    server.tasks = [row("needs_user")];
    renderPill();
    const pill = await screen.findByRole("button", { name: "Tasks, 1 needs you" });
    expect(pill.className).toContain("h-6");
    expect(pill.className).toContain("before:-inset-2");
  });

  it("wears the same colours whether the pane shows the list or the sheet is used", async () => {
    server.tasks = [row("needs_user")];
    const treatment = async (pane: ToolTasksHost | null) => {
      const view = renderPill(pane);
      const pill = await screen.findByRole("button", { name: "Tasks, 1 needs you" });
      const colours = pill.className.split(" ").filter((name) => name.includes("warning"));
      view.unmount();
      return colours;
    };
    const open = await treatment(host({ active: true }));
    expect(open.length).toBeGreaterThan(0);
    expect(await treatment(host())).toEqual(open);
    expect(await treatment(host({ compact: true }))).toEqual(open);
    expect(await treatment(null)).toEqual(open);
    // Open, hovered or resting, a needs-you pill never falls back to neutral grey.
    expect(open.join(" ")).not.toContain("bg-muted");
  });

  it("fetches and subscribes once when the navbar and the mobile header both render a pill", async () => {
    server.tasks = [row("needs_user")];
    FakeWebSocket.instances = [];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ConciergeTasksPill />
            <ConciergeTasksPill />
          </MemoryRouter>
        </QueryClientProvider>
      </LiveEventsClientContext.Provider>,
    );
    expect(await screen.findAllByRole("button", { name: "Tasks, 1 needs you" })).toHaveLength(2);
    const socket = acceptLatestSocket();
    const fetched = rs
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).startsWith("/api/concierge/tasks"));
    expect(fetched).toHaveLength(1);
    expect(
      (socket.sent as Array<{ topic: string }>).filter(
        (frame) => frame.topic === "concierge.tasks",
      ),
    ).toHaveLength(1);
  });

  it("says plurals in words", async () => {
    server.tasks = [row("needs_user"), row("needs_user")];
    renderPill();
    expect(await screen.findByRole("button", { name: "Tasks, 2 need you" })).toBeTruthy();
  });

  it("opens the pane's Tasks tab, and closes it when it is the open one", async () => {
    const user = userEvent.setup();
    const pane = host();
    const { rerender } = renderPill(pane);
    await user.click(await screen.findByRole("button", { name: "Tasks" }));
    expect(pane.show).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();

    const active = host({ active: true });
    const client = new QueryClient();
    rerender(
      <ToolTasksContext.Provider value={active}>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ConciergeTasksPill />
          </MemoryRouter>
        </QueryClientProvider>
      </ToolTasksContext.Provider>,
    );
    const open = screen.getByRole("button", { name: "Tasks" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    await user.click(open);
    expect(active.hide).toHaveBeenCalledTimes(1);
  });

  it("opens a full-height sheet instead where the pane would take the whole width", async () => {
    server.tasks = [row("doing", { title: "Fix flaky test" })];
    const user = userEvent.setup();
    const pane = host({ compact: true });
    renderPill(pane);
    await user.click(await screen.findByRole("button", { name: "Tasks, 1 in progress" }));
    const sheet = await screen.findByRole("dialog", { name: "Tasks" });
    expect(pane.show).not.toHaveBeenCalled();
    expect(sheet.className).toContain("inset-y-0");
    expect(sheet.className).toContain("w-full");
    expect(await within(sheet).findByText("Fix flaky test")).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Close tasks" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the sheet outside a tool workspace", async () => {
    const user = userEvent.setup();
    renderPill(null);
    await user.click(await screen.findByRole("button", { name: "Tasks" }));
    expect(await screen.findByRole("dialog", { name: "Tasks" })).toBeTruthy();
  });

  it("removes the pane's tab when the chat goes", async () => {
    const pane = host();
    const view = renderPill(pane);
    await screen.findByRole("button", { name: "Tasks" });
    view.unmount();
    expect(pane.hide).toHaveBeenCalled();
  });
});

describe("ConciergeTasksPill in a chat kept alive behind an Activity", () => {
  const topic = { type: "subscribe", topic: "concierge.tasks" };
  const kept = (
    mode: "visible" | "hidden",
    live: ReturnType<typeof fakeSocketLiveEventsClient>,
  ) => (
    <LiveEventsClientContext.Provider value={live}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Activity mode={mode}>
            <ConciergeTasksPill />
          </Activity>
        </MemoryRouter>
      </QueryClientProvider>
    </LiveEventsClientContext.Provider>
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const taskReads = () =>
    rs.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/api/concierge/tasks"));

  it("stops listening while hidden, and reads the list again and listens again when shown", async () => {
    FakeWebSocket.instances = [];
    client.clear();
    server.tasks = [row("doing")];
    const live = fakeSocketLiveEventsClient();
    const view = render(kept("visible", live));
    const socket = (() => FakeWebSocket.latest())();
    await screen.findByRole("button", { name: "Tasks, 1 in progress" });
    acceptLatestSocket();
    expect(
      socket.sent.filter((frame) => JSON.stringify(frame) === JSON.stringify(topic)),
    ).toHaveLength(1);

    view.rerender(kept("hidden", live));
    await waitFor(() =>
      expect(socket.sent).toContainEqual({ type: "unsubscribe", topic: "concierge.tasks" }),
    );
    const readsWhileHidden = taskReads().length;

    // The list changes while nobody listens; no event reaches the pill.
    server.tasks = [row("needs_user"), row("doing")];
    view.rerender(kept("visible", live));

    await waitFor(() => expect(taskReads().length).toBeGreaterThan(readsWhileHidden));
    await waitFor(() =>
      expect(screen.getByRole("button", { hidden: true, name: "Tasks, 1 needs you" })).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        socket.sent.filter((frame) => JSON.stringify(frame) === JSON.stringify(topic)),
      ).toHaveLength(2),
    );
  });

  it("closes the tasks tab of the pane as the chat is hidden", async () => {
    server.tasks = [row("doing")];
    const pane = host();
    const live = fakeSocketLiveEventsClient();
    const page = (mode: "visible" | "hidden") => (
      <ToolTasksContext.Provider value={pane}>{kept(mode, live)}</ToolTasksContext.Provider>
    );
    const view = render(page("visible"));
    await screen.findByRole("button", { name: "Tasks, 1 in progress" });
    expect(pane.hide).not.toHaveBeenCalled();

    view.rerender(page("hidden"));
    expect(pane.hide).toHaveBeenCalled();
  });
});
