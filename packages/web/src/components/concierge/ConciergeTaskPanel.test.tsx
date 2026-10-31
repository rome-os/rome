// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ConciergeTaskDto, ConciergeTaskState } from "@rome/api-types/concierge";
import i18n from "@/i18n";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import {
  acceptLatestSocket,
  FakeWebSocket,
  fakeSocketLiveEventsClient,
} from "@/test/fake-websocket";
import { onConciergeJump } from "./concierge-jump";
import { ConciergeTaskPanel } from "./ConciergeTaskPanel";
import { PENDING_TIMEOUT_MS, resetPending } from "./task-pending";

const toast = rs.hoisted(() => ({ error: rs.fn() }));
rs.mock("sonner", () => ({ toast }));

const DAY = 86_400_000;

let seq = 0;
function row(state: ConciergeTaskState, extra: Partial<ConciergeTaskDto> = {}): ConciergeTaskDto {
  seq += 1;
  return {
    id: `task-${seq}`,
    title: `Task ${seq}`,
    state,
    summary: null,
    waitingOn: null,
    dueAt: null,
    rank: null,
    chat: null,
    sourceMessageId: null,
    createdAt: Date.now() - 20 * DAY + seq,
    updatedAt: Date.now() - 60_000,
    completedAt: null,
    archivedAt: null,
    notSynced: false,
    ...extra,
  };
}

const server = {
  recent: [] as ConciergeTaskDto[],
  all: [] as ConciergeTaskDto[],
  /** The Concierge chat's recent messages and running turns, for the press check. */
  messages: [] as Array<Record<string, unknown>>,
  turns: [] as Array<Record<string, unknown>>,
};
const posts: Array<Record<string, unknown>> = [];
let postStatus = 200;

function mockServer() {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.startsWith("/api/concierge/tasks")) {
      return json({
        tasks: url.includes("doneDays=3650") ? [...server.recent, ...server.all] : server.recent,
      });
    }
    if (url === "/api/chat/sessions/concierge/turns" && init?.method !== "POST") {
      return json(server.turns);
    }
    if (url.startsWith("/api/chat/sessions/concierge/messages")) {
      return json({ messages: server.messages, nextCursor: null });
    }
    if (url === "/api/chat/sessions/concierge/turns" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return postStatus === 200
        ? json({ turnId: "turn-1", sessionId: "concierge", startedAt: "" })
        : json({ error: "nope" }, postStatus);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch);
}

function renderPanel(props: { onNavigate?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConciergeTaskPanel {...props} />
        </MemoryRouter>
      </QueryClientProvider>
    </LiveEventsClientContext.Provider>,
  );
  let socket!: FakeWebSocket;
  act(() => {
    socket = acceptLatestSocket();
  });
  return { ...view, socket };
}

const receive = (socket: FakeWebSocket, topic: string, event: string, data: unknown) =>
  act(() => socket.receive({ type: "event", topic, event, data }));
const upsert = (socket: FakeWebSocket, task: ConciergeTaskDto) =>
  receive(socket, "concierge.tasks", "task_upsert", { task });
/** The Concierge chat took the press with this input id into a turn that has ended. */
const consumed = (inputId: unknown, turnId = "turn-1") => ({
  id: inputId,
  turnId,
  inputState: "consumed",
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  seq = 0;
  server.recent = [];
  server.all = [];
  server.messages = [];
  server.turns = [];
  posts.length = 0;
  postStatus = 200;
  toast.error.mockClear();
  FakeWebSocket.instances = [];
  resetPending();
});
afterEach(() => {
  cleanup();
  rs.useRealTimers();
  rs.restoreAllMocks();
});

const groupButtons = () =>
  screen
    .getAllByRole("button", { name: /^(Needs you|Doing|Up next|Watching|Done) \d/ })
    .map((button) => button.textContent);
/** Opens the Done group, which starts folded. */
const openDone = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /^Done \d/ }));
const item = (title: string) => screen.getByText(title).closest("li")!;

describe("ConciergeTaskPanel", () => {
  it("groups rows as Needs you, Doing, Up next, Watching, Done, and hides empty groups", async () => {
    server.recent = [
      row("done", { title: "Shipped", completedAt: Date.now() - DAY }),
      row("watching", { title: "CI run" }),
      row("next", { title: "Second", rank: 2 }),
      row("next", { title: "First", rank: 1 }),
      row("doing", { title: "Fix flaky test" }),
      row("needs_user", { title: "Pick a budget" }),
    ];
    mockServer();
    renderPanel();
    await screen.findByText("Fix flaky test");
    expect(groupButtons()).toEqual(["Needs you 1", "Doing 1", "Up next 2", "Watching 1", "Done 1"]);
    const nextGroup = screen.getByRole("button", { name: /^Up next/ }).closest("section")!;
    expect(
      within(nextGroup)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining("First"), expect.stringContaining("Second")]);
    cleanup();

    server.recent = [row("doing", { title: "Only doing" })];
    renderPanel();
    await screen.findByText("Only doing");
    expect(groupButtons()).toEqual(["Doing 1"]);
  });

  it("starts with the finished group folded, and any group folds and opens from its heading", async () => {
    server.recent = [
      row("doing", { title: "Working" }),
      row("done", { title: "Shipped", completedAt: Date.now() - DAY }),
    ];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Working");
    const done = screen.getByRole("button", { name: /^Done \d/ });
    expect(done.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Shipped")).toBeNull();
    await user.click(done);
    expect(done.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Shipped")).toBeTruthy();

    const doing = screen.getByRole("button", { name: /^Doing\b/ });
    await user.click(doing);
    expect(screen.queryByText("Working")).toBeNull();
    await user.click(doing);
    expect(screen.getByText("Working")).toBeTruthy();
  });

  it("explains an empty list", async () => {
    mockServer();
    renderPanel();
    expect(await screen.findByText("No tasks yet")).toBeTruthy();
    expect(screen.getByText(/appear here/)).toBeTruthy();
  });

  it("shows one quiet line under the title: the summary, or what a watching or needs-you row waits for", async () => {
    server.recent = [
      row("doing", { title: "Reading logs", summary: "Looking at the CI failure" }),
      row("watching", { title: "CI run", summary: "ignored", waitingOn: "CI" }),
      row("needs_user", {
        title: "Budget call",
        summary: "ignored",
        waitingOn: "your budget call",
      }),
      row("watching", { title: "Bare watch", summary: "Checking hourly" }),
      row("next", { title: "Planned" }),
    ];
    mockServer();
    renderPanel();
    await screen.findByText("Reading logs");
    expect(item("Reading logs").textContent).toContain("Looking at the CI failure");
    expect(item("CI run").textContent).toContain("CI");
    expect(item("CI run").textContent).not.toContain("ignored");
    expect(item("Budget call").textContent).toContain("your budget call");
    expect(item("Bare watch").textContent).toContain("Checking hourly");
    expect(item("Planned").textContent).toBe("Planned");
  });

  it("shows a time only where it means something: when a row is due, and when one finished", async () => {
    const at = Date.now();
    server.recent = [
      row("doing", { title: "Busy", updatedAt: at - 5 * 60_000 }),
      row("needs_user", { title: "Blocked", updatedAt: at - 5 * 60_000 }),
      row("watching", { title: "Watched", dueAt: at + 25 * 60_000 + 1_000 }),
      row("next", { title: "Planned", dueAt: at + DAY + 1_000 }),
      row("next", { title: "Undated" }),
      row("done", { title: "Shipped", completedAt: at - 3 * DAY, updatedAt: at - 3 * 3_600_000 }),
    ];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Busy");
    await openDone(user);
    expect(item("Busy").textContent).toBe("Busy");
    expect(item("Blocked").textContent).toBe("Blocked");
    expect(item("Watched").textContent).toContain("in 25 min");
    expect(item("Planned").textContent).toContain("tomorrow");
    expect(item("Undated").textContent).toBe("Undated");
    expect(item("Shipped").textContent).toContain("3 days ago");
    expect(screen.queryByText(/\.$/)).toBeNull();
  });

  it("marks each state with its own glyph, and only the row that needs the guardian is amber", async () => {
    server.recent = [
      row("needs_user", { title: "Blocked" }),
      row("doing", { title: "Busy" }),
      row("next", { title: "Planned" }),
      row("watching", { title: "Watched" }),
      row("done", { title: "Shipped", completedAt: Date.now() - DAY }),
      row("dropped", { title: "Called off", completedAt: Date.now() - DAY }),
    ];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Busy");
    await openDone(user);
    const glyph = (title: string) => item(title).querySelector("svg")!;
    const shapes = ["Blocked", "Busy", "Planned", "Watched", "Shipped", "Called off"].map((title) =>
      glyph(title)
        .getAttribute("class")
        ?.split(" ")
        .find((name) => name.startsWith("lucide-") && name !== "lucide"),
    );
    expect(new Set(shapes).size).toBe(6);
    expect(glyph("Blocked").getAttribute("class")).toContain("text-warning");
    for (const title of ["Busy", "Planned", "Watched", "Shipped", "Called off"]) {
      expect(glyph(title).getAttribute("class")).not.toContain("warning");
    }
  });

  it("keeps a small open-chat link at the end of a row with a chat, and none on a row without one", async () => {
    server.recent = [
      row("doing", { title: "With chat", chat: { id: "chat-9", name: "Chat nine" } }),
      row("next", { title: "No chat" }),
    ];
    mockServer();
    renderPanel();
    const link = await screen.findByRole("link", { name: "Open the chat for With chat" });
    expect(link.getAttribute("href")).toBe("/chat/chat-9");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    // At the end of the row, after the title.
    expect(item("With chat").contains(link)).toBe(true);
    expect(
      screen.getByText("With chat").compareDocumentPosition(link) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not navigate to the chat when the row body is clicked", async () => {
    server.recent = [
      row("doing", {
        title: "With chat",
        chat: { id: "chat-9", name: "Chat nine" },
        sourceMessageId: "m1",
      }),
    ];
    mockServer();
    renderPanel();
    // The title is no link: the only link on the row is the open-chat icon.
    expect((await screen.findByText("With chat")).closest("a")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("jumps to a row's message when the row is clicked, whatever its state", async () => {
    server.recent = [
      row("doing", { title: "Running", chat: { id: "c1", name: "c" }, sourceMessageId: "m-run" }),
      row("next", { title: "Planned", sourceMessageId: "m-next" }),
      row("needs_user", { title: "Blocked", sourceMessageId: "m-ask" }),
      row("done", { title: "Shipped", completedAt: Date.now() - DAY, sourceMessageId: "m-done" }),
    ];
    mockServer();
    const jumps: string[] = [];
    const off = onConciergeJump((messageId) => jumps.push(messageId));
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Running");
    await openDone(user);
    for (const title of ["Running", "Planned", "Blocked", "Shipped"]) {
      await user.click(screen.getByText(title));
    }
    off();
    expect(jumps).toEqual(["m-run", "m-next", "m-ask", "m-done"]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("closes the mobile sheet before it asks for the jump", async () => {
    server.recent = [row("next", { title: "Planned", sourceMessageId: "m-next" })];
    mockServer();
    const order: string[] = [];
    const off = onConciergeJump(() => order.push("jump"));
    const user = userEvent.setup();
    renderPanel({ onNavigate: () => order.push("close") });
    await user.click(await screen.findByText("Planned"));
    off();
    expect(order).toEqual(["close", "jump"]);
  });

  it("says it can't find the original message for a row without one, and jumps nowhere", async () => {
    server.recent = [row("next", { title: "Old row", sourceMessageId: null })];
    mockServer();
    const jumps: string[] = [];
    const off = onConciergeJump((messageId) => jumps.push(messageId));
    const closed = rs.fn();
    const user = userEvent.setup();
    renderPanel({ onNavigate: closed });
    await user.click(await screen.findByText("Old row"));
    off();
    expect(jumps).toEqual([]);
    expect(closed).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Can't find the original message");
  });

  it("says it in Chinese too", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      server.recent = [row("next", { title: "旧任务", sourceMessageId: null })];
      mockServer();
      const user = userEvent.setup();
      renderPanel();
      await user.click(await screen.findByText("旧任务"));
      expect(toast.error).toHaveBeenCalledWith("找不到原消息");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("has the new strings in English and Chinese", () => {
    const keys = [
      "concierge.tasks.done",
      "concierge.tasks.pending.done",
      "concierge.tasks.actionText.done",
      "concierge.tasks.replyText.done",
      "concierge.tasks.sourceMissing",
      "concierge.tasks.findingMessage",
    ];
    for (const lng of ["en", "zh-CN"]) {
      for (const key of keys) {
        expect(i18n.exists(key, { ns: "chat", lng }), `${lng} ${key}`).toBe(true);
      }
    }
    expect(i18n.t("concierge.tasks.replyText.done", { ns: "chat", lng: "en" })).toBe(
      "I've done this",
    );
    expect(i18n.t("concierge.tasks.replyText.done", { ns: "chat", lng: "zh-CN" })).toBe(
      "我已经完成了",
    );
  });

  it("offers Stop on a Doing row with a chat, Done on a Needs you row, Archive on Done rows, and nothing on the rest, as icon buttons", async () => {
    server.recent = [
      row("doing", { title: "Running", chat: { id: "c1", name: "c" } }),
      row("doing", { title: "Chatless doing" }),
      row("needs_user", { title: "Blocked", chat: { id: "c2", name: "c" } }),
      row("next", { title: "Planned" }),
      row("watching", { title: "Watched", chat: { id: "c3", name: "c" } }),
      row("done", { title: "Finished", completedAt: Date.now() - DAY }),
      row("dropped", { title: "Called off", completedAt: Date.now() - DAY }),
    ];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Running");
    await openDone(user);
    // The title is a button too; the icon buttons are the ones with a label.
    const buttonsOf = (title: string) =>
      within(item(title))
        .queryAllByRole("button")
        .filter((button) => button.getAttribute("aria-label"))
        .map((button) => [button.getAttribute("aria-label"), button.textContent]);
    expect(buttonsOf("Running")).toEqual([["Stop", ""]]);
    expect(buttonsOf("Chatless doing")).toEqual([]);
    expect(buttonsOf("Blocked")).toEqual([["Done", ""]]);
    expect(buttonsOf("Planned")).toEqual([]);
    expect(buttonsOf("Watched")).toEqual([]);
    expect(buttonsOf("Finished")).toEqual([["Archive", ""]]);
    expect(buttonsOf("Called off")).toEqual([["Archive", ""]]);
  });

  it("keeps the action out of sight until the row is hovered or focused, and always on touch", async () => {
    server.recent = [row("doing", { title: "Running", chat: { id: "c1", name: "c" } })];
    mockServer();
    renderPanel();
    await screen.findByText("Running");
    const stop = within(item("Running")).getByRole("button", { name: "Stop" });
    for (const name of [
      "opacity-0",
      "group-hover/row:opacity-100",
      "group-focus-within/row:opacity-100",
      "focus-visible:opacity-100",
      "touch-show",
    ]) {
      expect(stop.className).toContain(name);
    }
  });

  it("sends Stop to the Concierge as a plain message with priority next, and waits for the row", async () => {
    const task = row("doing", { title: "Fix flaky test", chat: { id: "c1", name: "c" } });
    server.recent = [task];
    mockServer();
    const user = userEvent.setup();
    const { socket } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Stop" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    // The same words the guardian could type, as a plain message and nothing else.
    expect(posts[0]).toMatchObject({ text: 'Stop "Fix flaky test"', priority: "next" });
    expect(posts[0]).not.toHaveProperty("parts");
    // The row says so quietly under its title, with no action to press again.
    const status = await screen.findByText("Stopping…");
    expect(item("Fix flaky test").contains(status)).toBe(true);
    expect(
      within(item("Fix flaky test")).queryByRole("button", { name: /Stop|Try again/ }),
    ).toBeNull();

    // The Concierge stops it and writes the row: the pending state is gone.
    upsert(socket, {
      ...task,
      state: "dropped",
      completedAt: Date.now(),
      updatedAt: task.updatedAt + 5_000,
    });
    await waitFor(() => expect(screen.queryByText("Stopping…")).toBeNull());
    expect(screen.getByRole("button", { name: /^Done \d/ }).textContent).toBe("Done 1");
  });

  it("sends Archive the same way, and the row leaves the list when the Concierge archives it", async () => {
    const task = row("done", { title: "Shipped", completedAt: Date.now() - DAY });
    server.recent = [task];
    mockServer();
    const user = userEvent.setup();
    const { socket } = renderPanel();
    await user.click(await screen.findByRole("button", { name: /^Done \d/ }));
    await user.click(await screen.findByRole("button", { name: "Archive" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ text: 'Archive "Shipped"', priority: "next" });
    expect(posts[0]).not.toHaveProperty("parts");
    expect(await screen.findByText("Archiving…")).toBeTruthy();
    upsert(socket, { ...task, archivedAt: Date.now(), updatedAt: task.updatedAt + 5_000 });
    await waitFor(() => expect(screen.queryByText("Shipped")).toBeNull());
  });

  it("sends Done on a Needs you row as a reply to its message, in the guardian's language", async () => {
    const task = row("needs_user", { title: "Pay rent", sourceMessageId: "m-ask" });
    server.recent = [task];
    mockServer();
    const user = userEvent.setup();
    const { socket } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Done" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      text: "I've done this",
      replyToMessageId: "m-ask",
      priority: "next",
    });
    expect(posts[0]).not.toHaveProperty("parts");
    const status = await screen.findByText("Sending…");
    expect(item("Pay rent").contains(status)).toBe(true);
    expect(within(item("Pay rent")).queryByRole("button", { name: "Done" })).toBeNull();

    upsert(socket, {
      ...task,
      state: "done",
      completedAt: Date.now(),
      updatedAt: task.updatedAt + 5_000,
    });
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
  });

  it("sends Done in Chinese when the interface is", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      server.recent = [row("needs_user", { title: "交房租", sourceMessageId: "m-ask" })];
      mockServer();
      const user = userEvent.setup();
      renderPanel();
      await user.click(await screen.findByRole("button", { name: "完成" }));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]).toMatchObject({ text: "我已经完成了", replyToMessageId: "m-ask" });
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("sends Done as plain text naming the row when it has no message to reply to", async () => {
    server.recent = [row("needs_user", { title: "Pay rent", sourceMessageId: null })];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ text: 'Done "Pay rent"', priority: "next" });
    expect(posts[0]).not.toHaveProperty("replyToMessageId");
  });

  it("adds the short id to the plain Done text only when another open row has the same title", async () => {
    const first = row("needs_user", { title: "Pay rent" });
    const twin = row("needs_user", { title: "Pay rent" });
    server.recent = [first, twin];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await screen.findAllByText("Pay rent");
    for (const done of screen.getAllByRole("button", { name: "Done" })) await user.click(done);
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.map((post) => post.text).sort()).toEqual(
      [first, twin].map((task) => `Done "Pay rent" (task ${task.id.slice(0, 6)})`).sort(),
    );
  });

  it("repeats Done as a reply when the first press fails", async () => {
    server.recent = [row("needs_user", { title: "Pay rent", sourceMessageId: "m-ask" })];
    postStatus = 500;
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await screen.findByText("Could not send");
    postStatus = 200;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({ text: "I've done this", replyToMessageId: "m-ask" });
  });

  it("names the short id only when another open row has the same title", async () => {
    const same = row("doing", { title: "Fix flaky test", chat: { id: "c1", name: "c" } });
    const twin = row("doing", { title: "Fix flaky test", chat: { id: "c2", name: "c" } });
    const alone = row("doing", { title: "Plan next week", chat: { id: "c3", name: "c" } });
    server.recent = [same, twin, alone];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Plan next week");
    const stops = screen.getAllByRole("button", { name: "Stop" });
    // Rows list by recency: press each row's own button and read what was sent.
    for (const stop of stops) await user.click(stop);
    await waitFor(() => expect(posts).toHaveLength(3));
    const texts = posts.map((post) => post.text);
    expect(texts).toContain('Stop "Plan next week"');
    expect(texts).toContain(`Stop "Fix flaky test" (task ${same.id.slice(0, 6)})`);
    expect(texts).toContain(`Stop "Fix flaky test" (task ${twin.id.slice(0, 6)})`);
  });

  it("says the Concierge didn't change the row when the turn that took the press in ends without a write, and lets the press repeat", async () => {
    const task = row("doing", { title: "Fix flaky test", chat: { id: "c1", name: "c" } });
    server.recent = [task];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    await screen.findByText("Stopping…");
    expect(typeof posts[0].inputId).toBe("string");

    server.messages = [consumed(posts[0].inputId)];

    expect(
      await screen.findByText("Concierge did not change it", {}, { timeout: 4_000 }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(await screen.findByText("Stopping…")).toBeTruthy();
    expect(screen.queryByText("Concierge did not change it")).toBeNull();
  });

  it("with two presses pending, a turn that ended handling only the first leaves the second pending", async () => {
    server.recent = [
      row("doing", { title: "First task", chat: { id: "c1", name: "c" } }),
      row("doing", { title: "Second task", chat: { id: "c2", name: "c" } }),
    ];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    const li = (title: string) => screen.getByText(title).closest("li")!;
    await screen.findByText("First task");
    await user.click(within(li("First task")).getByRole("button", { name: "Stop" }));
    await user.click(within(li("Second task")).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(posts).toHaveLength(2));

    // Turn 1 took the first press in and ended; turn 2 is queued and has not
    // seen the second press.
    server.messages = [consumed(posts[0].inputId), { id: posts[1].inputId, inputState: "queued" }];
    server.turns = [{ turnId: "turn-2", status: "queued" }];

    expect(
      await within(li("First task")).findByText(
        "Concierge did not change it",
        {},
        { timeout: 4_000 },
      ),
    ).toBeTruthy();
    expect(within(li("Second task")).queryByText("Concierge did not change it")).toBeNull();
    expect(within(li("Second task")).getByText("Stopping…")).toBeTruthy();
  });

  it("says the Concierge hasn't handled it after 60 s, with a retry", async () => {
    const task = row("doing", { title: "Fix flaky test", chat: { id: "c1", name: "c" } });
    server.recent = [task];
    mockServer();
    const user = userEvent.setup({ advanceTimers: (ms) => rs.advanceTimersByTime(ms) });
    renderPanel();
    const stop = await screen.findByRole("button", { name: "Stop" });
    rs.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await user.click(stop);
    await screen.findByText("Stopping…");

    act(() => {
      rs.advanceTimersByTime(PENDING_TIMEOUT_MS - 2_000);
    });
    expect(screen.queryByText("Concierge has not handled this yet")).toBeNull();
    act(() => {
      rs.advanceTimersByTime(3_000);
    });
    expect(await screen.findByText("Concierge has not handled this yet")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(posts).toHaveLength(2));
  });

  it("says so when the message could not be sent", async () => {
    server.recent = [row("doing", { title: "Fix", chat: { id: "c1", name: "c" } })];
    postStatus = 500;
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Could not send")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("holds finished rows older than 7 days behind show more, counted, and folds them back", async () => {
    server.all = [
      row("done", { title: "Fresh", completedAt: Date.now() - 2 * DAY }),
      row("dropped", { title: "Stale", completedAt: Date.now() - 20 * DAY }),
      row("done", { title: "Ancient", completedAt: Date.now() - 200 * DAY }),
    ];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("button", { name: /^Done \d/ });
    expect(screen.getByRole("button", { name: /^Done \d/ }).textContent).toBe("Done 3");
    await openDone(user);
    expect(screen.getByText("Fresh")).toBeTruthy();
    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.queryByText("Ancient")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show 2 older" }));
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText("Ancient")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText("Ancient")).toBeNull();
  });

  it("offers show more for a Done group that has only old rows", async () => {
    server.all = [row("dropped", { title: "Long ago", completedAt: Date.now() - 30 * DAY })];
    mockServer();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: /^Done \d/ }));
    expect(await screen.findByRole("button", { name: "Show 1 older" })).toBeTruthy();
    expect(screen.queryByText("Long ago")).toBeNull();
  });

  it("marks a row the Concierge never picked up as not synced", async () => {
    const task = row("doing", { title: "Fix", chat: { id: "c1", name: "c" } });
    server.recent = [task];
    mockServer();
    const { socket } = renderPanel();
    await screen.findByText("Fix");
    expect(screen.queryByText("Not synced")).toBeNull();
    upsert(socket, { ...task, notSynced: true });
    expect(await screen.findByText("Not synced")).toBeTruthy();
  });

  it("adds, moves and removes rows as the Concierge writes them", async () => {
    server.recent = [row("doing", { title: "Existing", chat: { id: "c1", name: "c" } })];
    mockServer();
    const { socket } = renderPanel();
    await screen.findByText("Existing");
    upsert(socket, row("needs_user", { title: "Fresh question", waitingOn: "an answer" }));
    expect(await screen.findByRole("button", { name: /^Needs you\b/ })).toBeTruthy();
    expect(screen.getByText("an answer")).toBeTruthy();
  });
});
