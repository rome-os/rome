// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChatPendingCardJump } from "../ChatPendingCardJump";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { useTabStatus } from "@/hooks/use-tab-status";
import { LatestTaskChatsContext, renderFlatEntries } from "./render";
import { useLiveEvents } from "@/hooks/use-live-events";
import type { ChatMessage, TranscriptPart } from "@/lib/chat-types";
import { TaskChatCard } from "./TaskChatCard";

rs.mock("@/hooks/use-live-events", () => ({
  chatStatusTopic: "chat-status",
  useLiveEvents: rs.fn(),
}));

rs.mock("@/hooks/use-tab-status", () => ({ useTabStatus: rs.fn() }));

const chatId = "task-chat";
const question: TranscriptPart = {
  type: "pending_interaction",
  toolUseId: "item_0",
  appId: "core",
  render: {
    kind: "inline",
    builtin: true,
    componentId: "question-card",
    props: {
      questions: [
        { id: "tone", question: "Which tone?", type: "single", options: ["Warm", "Plain"] },
      ],
    },
  },
};
const message = (
  id: string,
  parts: TranscriptPart[],
  role: ChatMessage["role"] = "assistant",
  at = "2026-11-10T10:00:00Z",
): ChatMessage => ({
  id,
  sessionId: chatId,
  role,
  content: JSON.stringify(parts),
  createdAt: at,
});
const result: TranscriptPart = {
  type: "interaction_result",
  toolUseId: "item_0",
  output: { dismissed: true },
};
const approval = (threadId = chatId, at = "2026-11-10T11:00:00Z") => ({
  id: "approval-1",
  status: "pending",
  createdAt: at,
  description: "Send the draft",
  payload: {
    channelContext: { threadId },
    actionName: "mail:send",
    preview: { kind: "generic", title: "Send the draft", summary: "Email the final draft." },
  },
});

let client: QueryClient;
let messages: ChatMessage[];
let approvals: ReturnType<typeof approval>[];
let waiting: boolean;
let running: boolean;
let postStatus: number;
let postAction: () => void;
let fetchMock: ReturnType<typeof rs.fn<typeof fetch>>;
/** The task rows the list answers, and the tasks a Stop on the card stopped. */
let taskRows: Record<string, unknown>[] = [];
let stopped: string[] = [];

beforeEach(async () => {
  await i18n.changeLanguage("en");
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 10_000 }, mutations: { retry: false } },
  });
  messages = [message("ask", [question])];
  approvals = [];
  waiting = true;
  running = false;
  postStatus = 202;
  postAction = () => {};
  taskRows = [];
  stopped = [];
  fetchMock = rs.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/concierge/tasks?")) return Response.json({ tasks: taskRows });
    const stop = url.match(/^\/api\/concierge\/tasks\/([^/]+)\/stop$/);
    if (stop && init?.method === "POST") {
      stopped.push(stop[1]!);
      return Response.json({ ok: true });
    }
    if (url.endsWith("/turns") && init?.method === "POST") {
      postAction();
      return Response.json(
        postStatus === 400
          ? { error: "No open suspension" }
          : { turnId: "task-turn", streamId: "task-stream" },
        { status: postStatus },
      );
    }
    if (url.startsWith("/api/chat/sessions?"))
      return Response.json([
        { id: chatId, name: "Draft email", awaitingGuardian: waiting, running },
      ]);
    if (url === `/api/chat/sessions/${chatId}/messages?limit=2`)
      return Response.json({ messages, nextCursor: "older-turn" });
    if (url === "/api/approvals?status=pending") return Response.json(approvals);
    if (url === "/api/approvals/approval-1")
      return Response.json({ id: "approval-1", status: "pending" });
    if (url === "/api/approvals/approval-1/approve" && init?.method === "POST")
      return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  });
  rs.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  client.clear();
  rs.useRealTimers();
  rs.unstubAllGlobals();
  rs.restoreAllMocks();
});

describe("TaskChatCard with its task", () => {
  const taskRow = (status: string, endReason: string | null = null) => ({
    id: "task-9",
    title: "Draft email",
    state: "doing",
    status,
    endReason,
    summary: null,
    waitingOn: null,
    dueAt: null,
    rank: null,
    chat: { id: chatId, name: "Draft email" },
    conciergeChat: { id: "concierge", name: "Concierge", main: true },
    sourceMessageId: null,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    archivedAt: null,
    notSynced: false,
  });

  it("says its task's status, as the task list does, and stops the task from the card", async () => {
    waiting = false;
    taskRows = [taskRow("later")];
    show();
    expect(await screen.findByText("Task chat · Later")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stopped).toEqual(["task-9"]));
  });

  it("labels a question nobody answered in time as expired, and keeps it answerable", async () => {
    taskRows = [taskRow("ended", "no_response")];
    show();
    expect(await screen.findByText("Expired — answer to continue")).toBeTruthy();
    expect(await screen.findByText("Task chat · No response")).toBeTruthy();
  });

  it("offers no Stop once its task ended, and says why it ended", async () => {
    waiting = false;
    taskRows = [taskRow("ended", "no_response")];
    show();
    expect(await screen.findByText("Task chat · No response")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

function show(isLatestForChat = true) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/chat/main-chat"]}>
        <TaskChatCard chatId={chatId} title="Task" isLatestForChat={isLatestForChat} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function TaskJumpHarness() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [floor, setFloor] = useState<HTMLDivElement | null>(null);
  const older = { type: "task_chat", chatId, title: "Started" } as const;
  const latest = { ...older, title: "Question" };
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LatestTaskChatsContext.Provider value={new Map([[chatId, latest]])}>
          <div ref={setScroller} data-testid="task-scroller">
            <div ref={setContent}>{renderFlatEntries([older, latest])}</div>
            <div ref={setFloor} data-testid="task-floor">
              <ChatPendingCardJump
                scroller={scroller}
                content={content}
                floor={floor}
                currentReplyMessageIds={new Set(["unrelated-main-reply"])}
              />
            </div>
          </div>
        </LatestTaskChatsContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function posts() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
}

describe("TaskChatCard", () => {
  it("keeps older blocks compact without pending targets, tab claims or card requests", async () => {
    show(false);
    await screen.findByText("Draft email");
    expect(screen.getByText("Task chat · Needs you")).toBeTruthy();
    expect(screen.getByRole("link").textContent).toBe("Open");
    expect(document.querySelector("[data-chat-pending-card]")).toBeNull();
    expect(rs.mocked(useTabStatus).mock.calls).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => /messages|approvals/.test(String(url)))).toBe(
      false,
    );
  });

  for (const kind of ["question", "approval"] as const) {
    it(`mounts ${kind} controls and a pending target only in the newest block`, async () => {
      if (kind === "approval") {
        messages = [];
        approvals = [approval()];
      }
      const older = { type: "task_chat", chatId, title: "Started" } as const;
      const latest = { ...older, title: "Question" };
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <LatestTaskChatsContext.Provider value={new Map([[chatId, latest]])}>
              {renderFlatEntries([older, latest])}
            </LatestTaskChatsContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await screen.findByRole("button", { name: kind === "question" ? "Send" : "Approve" });
      expect(screen.getAllByRole("link")).toHaveLength(2);
      expect(
        screen.getAllByRole("button", { name: kind === "question" ? "Send" : "Approve" }),
      ).toHaveLength(1);
      expect(document.querySelectorAll("[data-chat-pending-card]")).toHaveLength(1);
      if (kind === "approval") {
        await waitFor(() =>
          expect(
            rs.mocked(useTabStatus).mock.calls.some(([status]) => status === "needs-you"),
          ).toBe(true),
        );
      }
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/messages")),
      ).toHaveLength(1);
    });
  }

  it("jumps to an offscreen task question independently of the main Chat reply", async () => {
    let cardTop = -200;
    rs.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const top =
        this.dataset.testid === "task-scroller"
          ? 0
          : this.dataset.testid === "task-floor"
            ? 500
            : cardTop;
      return new DOMRect(0, top, 400, this.dataset.testid === "task-scroller" ? 600 : 100);
    });
    render(<TaskJumpHarness />);
    const scroller = screen.getByTestId("task-scroller");
    const scrollTo = rs.fn(() => {
      cardTop = 0;
      fireEvent.scroll(scroller);
    });
    scroller.scrollTo = scrollTo;
    await screen.findByText("Which tone?");
    const pending = document.querySelector<HTMLElement>("[data-chat-pending-card]")!;
    expect(pending.closest("[data-chat-card-message]")).toBeNull();
    expect(document.querySelectorAll("[data-chat-pending-card]")).toHaveLength(1);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    await userEvent.click(
      await screen.findByRole("button", { name: "Needs you: jump to waiting card" }),
    );
    expect(scrollTo).toHaveBeenCalledWith({ top: -200, behavior: "instant" });
    expect(document.activeElement).toBe(pending);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBeNull(),
    );
    cardTop = -200;
    fireEvent.scroll(scroller);
    await screen.findByRole("button", { name: "Needs you: jump to waiting card" });
    const handlers = rs
      .mocked(useLiveEvents)
      .mock.calls.filter(([, handlers]) => "session_running" in (handlers ?? {}))
      .at(-1)?.[1];
    act(() => {
      handlers?.session_running.fn({ sessionId: chatId, running: true });
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBeNull(),
    );
    expect(document.querySelector("[data-chat-pending-card]")).toBeNull();
  });

  it("fetches a bounded page of whole turns without polling the transcript", async () => {
    messages = [
      ...Array.from({ length: 40 }, (_, i) =>
        message(`row-${i}`, [{ type: "text", content: "Working" }]),
      ),
      message("ask", [question]),
    ];
    rs.useFakeTimers();
    show();
    for (let i = 0; i < 10 && !screen.queryByText("Which tone?"); i += 1) {
      await act(async () => {
        await rs.advanceTimersByTimeAsync(100);
      });
    }
    expect(screen.getByText("Which tone?")).toBeTruthy();
    await act(async () => {
      await rs.advanceTimersByTimeAsync(15_000);
    });
    const requests = fetchMock.mock.calls.filter(([url]) => String(url).includes("/messages"));
    expect(requests.map(([url]) => url)).toEqual([`/api/chat/sessions/${chatId}/messages?limit=2`]);
  });

  it("loads a fresh page when live running events remount the waiting card within staleTime", async () => {
    show();
    await screen.findByText("Which tone?");
    const notify = (running: boolean) => {
      const handlers = rs
        .mocked(useLiveEvents)
        .mock.calls.filter(([, handlers]) => "session_running" in (handlers ?? {}))
        .at(-1)?.[1];
      act(() => {
        handlers?.session_running.fn({ sessionId: chatId, running });
      });
    };
    notify(true);
    messages = [
      message("next", [
        {
          ...question,
          toolUseId: "item_1",
          render: {
            ...question.render,
            props: { questions: [{ id: "next", question: "Next question?", type: "text" }] },
          },
        },
      ]),
    ];
    expect(
      Date.now() - client.getQueryState(["task-chat-cards", chatId])!.dataUpdatedAt,
    ).toBeLessThan(10_000);
    notify(false);
    await screen.findByText("Next question?");
    expect(screen.queryByText("Which tone?")).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/messages"))).toHaveLength(
      2,
    );
  });

  it("allows a later question in the same mounted card to be answered", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await screen.findByText("Dismissed");
    const nextQuestion = {
      ...question,
      toolUseId: "item_1",
      render: {
        ...question.render,
        props: {
          questions: [{ id: "next", question: "Next question?", type: "single", options: ["Yes"] }],
        },
      },
    };
    messages = [message("next", [nextQuestion])];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["task-chat-cards", chatId] });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Yes" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.parse(String(posts()[1][1]?.body)).parts[0]).toMatchObject({
      toolUseId: "item_1",
      output: { answers: [{ questionId: "next", value: "Yes" }] },
    });
  });

  it("shows the task's question and posts its answer to the task, not the main chat", async () => {
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Warm" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0];
    expect(url).toBe(`/api/chat/sessions/${chatId}/turns`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      parts: [
        {
          type: "interaction_result",
          toolUseId: "item_0",
          output: { answers: [{ questionId: "tone", value: "Warm" }] },
        },
      ],
    });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(`/chat/${chatId}`);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/chat/sessions?"))
          .length,
      ).toBeGreaterThan(1),
    );
  });

  it("collapses after the session refresh says the task no longer needs input", async () => {
    postAction = () => {
      waiting = false;
    };
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Which tone?")).toBeNull());
    expect(screen.getByRole("link")).toBeTruthy();
  });

  it("dismisses the task's question directly", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0][1]?.body)).parts[0].output).toEqual({ dismissed: true });
    expect(screen.getByText("Dismissed")).toBeTruthy();
  });

  it("shows an approval belonging to this task with the existing approval controls", async () => {
    messages = [];
    approvals = [approval("other-chat"), approval()];
    show();
    expect(await screen.findByText("Send the draft")).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe("/api/approvals/approval-1/approve");
  });

  for (const preview of [
    undefined,
    { kind: "generic", title: "No summary" },
    { kind: "unknown" },
  ]) {
    it(`keeps an approval with ${JSON.stringify(preview)} preview actionable`, async () => {
      messages = [];
      const row = approval();
      approvals = [{ ...row, payload: { ...row.payload, preview } } as ReturnType<typeof approval>];
      show();
      expect(await screen.findByText("Send the draft")).toBeTruthy();
      expect(screen.queryByText("No summary")).toBeNull();
      await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0][0]).toBe("/api/approvals/approval-1/approve");
    });
  }

  it("ignores approvals from another task", async () => {
    approvals = [approval("other-chat")];
    show();
    expect(await screen.findByText("Which tone?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  for (const state of ["idle", "running"] as const) {
    it(`does not load or show inline cards when ${state}`, async () => {
      waiting = state === "running";
      running = state === "running";
      show();
      await screen.findByText("Draft email");
      expect(screen.queryByText("Which tone?")).toBeNull();
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url).includes("/messages") || String(url).includes("/approvals"),
        ),
      ).toBe(false);
    });
  }

  it("collapses when the task starts running live", async () => {
    show();
    await screen.findByText("Which tone?");
    const handlers = rs
      .mocked(useLiveEvents)
      .mock.calls.filter(([, handlers]) => "session_running" in (handlers ?? {}))
      .at(-1)?.[1];
    act(() => {
      handlers?.session_running.fn({ sessionId: chatId, running: true });
    });
    expect(screen.queryByText("Which tone?")).toBeNull();
  });

  it("closes only earlier cards and shows the latest reopened tool id", async () => {
    messages = [
      message("first", [question]),
      message("answer", [result], "user"),
      message("second", [
        {
          ...question,
          render: {
            ...question.render,
            props: { questions: [{ id: "again", question: "Ask again?", type: "text" }] },
          },
        },
      ]),
    ];
    show();
    expect(await screen.findByText("Ask again?")).toBeTruthy();
    expect(screen.queryByText("Which tone?")).toBeNull();
  });

  it("does not render a question with a later result", async () => {
    messages.push(message("answer", [result], "user"));
    show();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/messages"))).toBe(true),
    );
    expect(screen.queryByText("Which tone?")).toBeNull();
  });

  it("keeps only the link when the latest open card belongs to an app", async () => {
    messages.push(
      message("app", [
        { ...question, toolUseId: "custom", render: { kind: "inline", componentId: "custom" } },
      ]),
    );
    show();
    await screen.findByText("Draft email");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/messages"))).toBe(true),
    );
    expect(screen.queryByText("Which tone?")).toBeNull();
    expect(screen.getByRole("link")).toBeTruthy();
  });

  it("shows only the latest open card across questions and approvals", async () => {
    approvals = [approval()];
    show();
    expect(await screen.findByText("Email the final draft.")).toBeTruthy();
    expect(screen.queryByText("Which tone?")).toBeNull();
  });

  it("refetches a card answered elsewhere after a 400, without repeating the post", async () => {
    postStatus = 400;
    postAction = () => {
      messages.push(message("answer", [result], "user"));
    };
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Which tone?")).toBeNull());
    expect(posts()).toHaveLength(1);
  });

  it("allows retry after a network failure", async () => {
    show();
    await screen.findByText("Which tone?");
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await screen.findByRole("status");
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
  });
});
