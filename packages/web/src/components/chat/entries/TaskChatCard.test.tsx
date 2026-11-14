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
import type { ChatEntry, ChatMessage, TranscriptPart } from "@/lib/chat-types";
import { TaskChatCard } from "./TaskChatCard";
import { WidgetHostContext } from "./widget-ui/turn-fields";
import { questionCardRender } from "../../../../mock/fixtures/question-card";
import type { TaskCard } from "@rome/api-types/chat";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import { cardKey, LiveTaskCardsProvider } from "./live-task-cards";
import { waitingTaskCardMessages } from "../waiting-task-cards";

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
  render: questionCardRender([
    { id: "tone", question: "Which tone?", type: "single", options: ["Warm", "Plain"] },
  ]),
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
/** Every approval the list answers, resolved ones included. */
let allApprovals: Record<string, unknown>[];
let waiting: boolean;
let running: boolean;
let postStatus: number;
let postAction: () => void;
let fetchMock: ReturnType<typeof rs.fn<typeof fetch>>;
/** The task rows the list answers, and the tasks a Stop on the card stopped. */
let taskRows: Record<string, unknown>[] = [];
/** When the task chat was archived, or null. */
let archivedAt: string | null = null;
let stopped: string[] = [];
/** How many times the chat list was read. */
let sessionReads = 0;

/**
 * What the server says the task chat waits on, as `openWait`: the newest open
 * card or pending approval while the chat waits on its owner.
 */
function openWait() {
  if (!waiting) return null;
  const open = new Map<string, { id: string; messageId: string; render: unknown; at: string }>();
  for (const each of messages) {
    for (const part of JSON.parse(each.content) as TranscriptPart[]) {
      if (part.type !== "pending_interaction" && part.type !== "interaction_result") continue;
      open.delete(part.toolUseId);
      if (part.type === "pending_interaction") {
        open.set(part.toolUseId, {
          id: part.toolUseId,
          messageId: each.id,
          render: part.render,
          at: each.createdAt,
        });
      }
    }
  }
  const card = [...open.values()].at(-1);
  const pending = approvals
    .filter((row) => row.status === "pending" && row.payload.channelContext.threadId === chatId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (pending && (!card || Date.parse(pending.createdAt) > Date.parse(card.at))) {
    return { kind: "approval", id: pending.id, since: Date.parse(pending.createdAt) };
  }
  return card
    ? {
        kind: "card",
        id: card.id,
        messageId: card.messageId,
        render: card.render,
        since: Date.parse(card.at),
      }
    : null;
}

/**
 * Whether the task ended, as Rome reads it for `closed`: a row that says so,
 * or, with no row, a task chat that neither waits on its owner nor runs.
 */
function taskEnded() {
  if (taskRows.length > 0) return taskRows.some((row) => row.status === "ended");
  return !waiting && !running;
}

/**
 * The card Rome fills a task card with, as it would read the fixtures now:
 * the newest question or approval the task chat asked by `until`, and how it
 * ended.
 */
function cardNow(until = Number.POSITIVE_INFINITY): TaskCard {
  type Asked = {
    id: string;
    messageId: string;
    render: unknown;
    at: number;
    output?: Record<string, unknown>;
  };
  const questions: Asked[] = [];
  const open = new Map<string, Asked>();
  for (const each of messages) {
    for (const part of JSON.parse(each.content) as TranscriptPart[]) {
      if (part.type === "pending_interaction" && Date.parse(each.createdAt) <= until) {
        const asked = {
          id: part.toolUseId,
          messageId: each.id,
          render: part.render,
          at: Date.parse(each.createdAt),
        };
        questions.push(asked);
        open.set(part.toolUseId, asked);
      } else if (part.type === "interaction_result") {
        const asked = open.get(part.toolUseId);
        if (asked) asked.output = (part.output as Record<string, unknown>) ?? {};
        open.delete(part.toolUseId);
      }
    }
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...allApprovals, ...approvals] as Record<string, unknown>[])
    byId.set(row.id as string, row);
  const asked = [...byId.values()]
    .filter(
      (row) =>
        (row.payload as { channelContext: { threadId: string } }).channelContext.threadId ===
          chatId && Date.parse(row.createdAt as string) <= until,
    )
    .sort((a, b) => Date.parse(a.createdAt as string) - Date.parse(b.createdAt as string))
    .at(-1);
  const question = questions.at(-1);
  if (asked && (!question || Date.parse(asked.createdAt as string) > question.at)) {
    const payload = asked.payload as {
      actionName?: string;
      preview?: { kind?: string; title?: string };
    };
    const status = asked.status as string;
    const outcome =
      status === "pending"
        ? undefined
        : status === "rejected"
          ? asked.resolvedBy === "rome:task-ended"
            ? { kind: "turned_down" as const, reason: "no_response" as const }
            : asked.resolvedBy === "rome:task-stopped"
              ? { kind: "turned_down" as const, reason: "task_stopped" as const }
              : { kind: "rejected" as const }
          : { kind: "approved" as const };
    return {
      kind: "approval",
      id: asked.id as string,
      title:
        payload.preview?.kind === "generic" &&
        payload.preview.title &&
        typeof (payload.preview as { summary?: unknown }).summary === "string"
          ? payload.preview.title
          : (asked.description as string),
      ...(payload.actionName ? { actionName: payload.actionName } : {}),
      ...(payload.preview ? { preview: payload.preview } : {}),
      since: Date.parse(asked.createdAt as string),
      ...(outcome ? { outcome } : {}),
      closed: !outcome && taskEnded(),
    };
  }
  if (!question) return { kind: "unavailable" };
  const output = question.output;
  const outcome = !output
    ? undefined
    : output.dismissed === true
      ? { kind: "dismissed" as const }
      : {
          kind: "answered" as const,
          answer: {
            text: ((output.answers as { value?: string }[] | undefined) ?? [])
              .map((a) => a.value)
              .join(", "),
            output,
          },
        };
  const ended = taskRows.some((row) => row.endReason === "no_response");
  const expired = !outcome && ended;
  return {
    kind: "question",
    id: question.id,
    messageId: question.messageId,
    render: question.render as Extract<TaskCard, { kind: "question" }>["render"],
    since: question.at,
    expired,
    ...(outcome ? { outcome } : {}),
    closed: !outcome && !expired && taskEnded(),
  };
}

/** A task card as Rome hands it out, read again whenever the task list reloads, as after a settle. */
function Served({
  isLatestForChat,
  as,
  until,
}: {
  isLatestForChat: boolean;
  as?: "task" | "ask";
  until?: number;
}) {
  // Read again whenever the chat lists reload, as a settle does.
  useChatSessions("all", "all");
  return (
    <TaskChatCard
      chatId={chatId}
      title="Task"
      isLatestForChat={isLatestForChat}
      show={as}
      card={as === "task" ? undefined : cardNow(until)}
    />
  );
}

/** Blocks as Rome hands them out, each with its card, read again whenever the task list reloads. */
function ServedBlocks({
  blocks,
  newest = true,
}: {
  blocks: (Record<string, unknown> & { type: "task_chat" })[];
  /** Whether these blocks end with the chat's newest card; a later message holds it otherwise. */
  newest?: boolean;
}) {
  useChatSessions("all", "all");
  const card = cardNow();
  const served = blocks.map((block) => ({ ...block, card }) as never as ChatEntry);
  // The newest card for the chat is the last one, as the transcript tells it.
  return (
    <LatestTaskChatsContext.Provider
      value={
        new Map([[chatId, newest ? served.at(-1)! : ({ type: "text", content: "" } as ChatEntry)]])
      }
    >
      {renderFlatEntries(served)}
    </LatestTaskChatsContext.Provider>
  );
}

/** The task rows the list answers: each with its open wait, or one that only waits. */
function servedTasks() {
  const wait = openWait();
  if (taskRows.length === 0) {
    // An archived task chat's task is not in the list.
    return wait && !archivedAt
      ? [
          {
            id: "task-waiting",
            title: "Draft email",
            state: "needs_user",
            status: "needs_you",
            endReason: null,
            chat: { id: chatId, name: "Draft email" },
            conciergeChat: { id: "concierge", name: "Concierge", main: true },
            createdAt: 1,
            updatedAt: 2,
            openWait: wait,
          },
        ]
      : [];
  }
  return taskRows.map((row) => ("openWait" in row ? row : { ...row, openWait: wait }));
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 10_000 }, mutations: { retry: false } },
  });
  messages = [message("ask", [question])];
  approvals = [];
  allApprovals = [];
  waiting = true;
  running = false;
  postStatus = 202;
  postAction = () => {};
  taskRows = [];
  stopped = [];
  archivedAt = null;
  fetchMock = rs.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/concierge/tasks?")) return Response.json({ tasks: servedTasks() });
    const stop = url.match(/^\/api\/concierge\/tasks\/([^/]+)\/stop$/);
    if (stop && init?.method === "POST") {
      stopped.push(stop[1]!);
      return Response.json({ ok: true });
    }
    if (url.endsWith("/events") && init?.method === "POST") {
      postAction();
      return Response.json(
        postStatus === 400
          ? { error: "No open suspension" }
          : { turnId: "task-turn", streamId: "task-stream", answered: true },
        { status: postStatus },
      );
    }
    if (url.startsWith("/api/chat/sessions?")) {
      // Each read is new, as a settle changes the chat's activity.
      sessionReads += 1;
      return Response.json([
        {
          id: chatId,
          name: "Draft email",
          awaitingGuardian: waiting,
          running,
          archivedAt,
          activityAt: String(sessionReads),
        },
      ]);
    }
    if (url === `/api/chat/sessions/${chatId}/messages?limit=2`)
      return Response.json({ messages, nextCursor: "older-turn" });
    if (url === "/api/approvals?status=pending") return Response.json(approvals);
    if (url === "/api/approvals") return Response.json(allApprovals);
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

  it("says Working while its task chat runs and Needs you while it waits, from the chat alone", async () => {
    running = true;
    waiting = false;
    const first = show(true, "task");
    expect(await first.findByText("Task chat · Working")).toBeTruthy();
    first.unmount();
    client.clear();
    running = false;
    waiting = true;
    show(true, "task");
    expect(await screen.findByText("Task chat · Needs you")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/concierge/tasks"))).toBe(
      false,
    );
  });

  it("labels a question nobody answered in time as expired, and keeps it answerable", async () => {
    taskRows = [taskRow("ended", "no_response")];
    waiting = false;
    show();
    expect(await screen.findByText("Expired — answer to continue")).toBeTruthy();
    // The question is still there to answer.
    expect(document.querySelector("[data-chat-task-open]")).toBeTruthy();
  });

  it("shows no status line for a task that neither works nor waits, and no Stop", async () => {
    for (const [status, reason] of [
      ["later", null],
      ["ended", "done"],
      ["ended", "stopped"],
      ["ended", "failed"],
    ] as const) {
      waiting = false;
      taskRows = [taskRow(status, reason)];
      const view = show(true, "task");
      expect(await view.findByText("Task chat")).toBeTruthy();
      expect(view.queryByText(/Task chat · /)).toBeNull();
      expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
      view.unmount();
      client.clear();
    }
  });
});

function show(isLatestForChat = true, as?: "task" | "ask", until?: number) {
  // The Chat the card is shown in has turn fields of its own.
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/chat/main-chat"]}>
        <WidgetHostContext.Provider value={MAIN_CHAT_HOST}>
          <Served isLatestForChat={isLatestForChat} as={as} until={until} />
        </WidgetHostContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const MAIN_CHAT_HOST = {
  turnFields: () => ({ personaId: "main-persona", workspace: { id: "main-ws" } }),
};

describe("TaskChatCard shown as one card or the other", () => {
  const expiredRow = {
    id: "task-9",
    title: "Draft email",
    state: "dropped",
    status: "ended",
    endReason: "no_response",
    chat: { id: chatId, name: "Draft email" },
    conciergeChat: { id: "concierge", name: "Concierge", main: true },
    createdAt: 1,
    updatedAt: 2,
  };
  const answered = (value: string): ChatMessage =>
    message("answer", [
      {
        type: "interaction_result",
        toolUseId: "item_0",
        output: { answers: [{ questionId: "tone", value }] },
      },
    ]);

  it("shows a task's question alone, with no header, Stop, Open or status", async () => {
    show(true, "ask");
    expect(await screen.findByText("Which tone?")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByText(/Task chat ·/)).toBeNull();
    // It waits on the guardian: the Needs you jump counts it.
    expect(document.querySelector("[data-chat-task-waiting]")).toBeTruthy();
  });

  it("shows an approval the same way", async () => {
    messages = [];
    approvals = [approval()];
    show(true, "ask");
    expect(await screen.findByText("Email the final draft.")).toBeTruthy();
    expect(screen.queryByText(/Task chat ·/)).toBeNull();
  });

  it("folds an answered question to what it asked and how it ended, and opens it read-only", async () => {
    postAction = () => {
      waiting = false;
      messages = [...messages, answered("Warm")];
    };
    show(true, "ask");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Warm" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    const folded = (await screen.findByText("Answered: Warm")).closest("button")!;
    expect(folded.textContent).toContain("Which tone?");
    expect(folded.getAttribute("aria-expanded")).toBe("false");
    await user.click(folded);
    expect(folded.getAttribute("aria-expanded")).toBe("true");
    // The original card, answered: nothing to send.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("shows an app's own waiting card as a card that opens the task chat, not an empty block", async () => {
    messages = [
      message("ask", [
        {
          type: "pending_interaction",
          toolUseId: "item_1",
          appId: "connector",
          render: { kind: "inline", componentId: "login-card", props: {} },
        },
      ]),
    ];
    show(true, "ask");
    const card = await screen.findByRole("button", { name: "Open the task chat to answer" });
    // It is what the "Needs you" jump lands on.
    expect(card.closest("[data-chat-task-waiting]")).toBeTruthy();
  });

  it("folds an expired question to a card that waits on no one, and opens to the form", async () => {
    taskRows = [expiredRow];
    show(true, "ask");
    // In a card like any settled one: what it asked, then that it expired.
    const line = await screen.findByRole("button", {
      name: "Which tone?Expired · answer to continue",
    });
    expect(line.closest("[data-chat-settled-card]")).toBeTruthy();
    // The card says it expired itself: no task list is read.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/concierge/tasks"))).toBe(
      false,
    );
    expect(screen.queryByRole("button", { name: "Warm" })).toBeNull();
    expect(document.querySelector("[data-chat-task-waiting]")).toBeNull();
    await userEvent.setup().click(line);
    expect(await screen.findByText("Which tone?")).toBeTruthy();
    expect(screen.getByText("Expired — answer to continue")).toBeTruthy();
    // Opened, it still takes an answer, but counts as waiting nowhere.
    expect(document.querySelector("[data-chat-task-waiting]")).toBeNull();
  });

  describe("folded", () => {
    const folded = async (outcome: string) => {
      waiting = false;
      show(true, "ask");
      const text = await screen.findByText(outcome);
      return text.closest("button")!;
    };
    const decided = (status: string, resolvedBy: string) => ({
      ...approval(),
      status,
      resolvedBy,
      createdAt: "2026-11-10T12:00:00Z",
    });

    it("says a question was answered, with the answer when it is short", async () => {
      messages = [message("ask", [question]), answered("Warm")];
      expect((await folded("Answered: Warm")).textContent).toContain("Which tone?");
    });

    it("says only Answered when the answer is long", async () => {
      messages = [message("ask", [question]), answered("Warm, but keep it short and kind")];
      await folded("Answered");
    });

    it("says a question was dismissed", async () => {
      messages = [message("ask", [question]), message("answer", [result])];
      await folded("Dismissed");
    });

    it("says an approval the guardian approved, under its title", async () => {
      allApprovals = [decided("executed", "dev")];
      expect((await folded("Approved")).textContent).toContain("Send the draft");
    });

    it("keeps showing the wait it was shown for after the task asks for another", async () => {
      waiting = false;
      allApprovals = [
        { ...decided("executed", "dev"), createdAt: "2026-11-10T12:00:00Z" },
        {
          ...decided("rejected", "dev"),
          id: "approval-2",
          createdAt: "2026-11-10T13:00:00Z",
          payload: {
            ...approval().payload,
            preview: { kind: "generic", title: "Book the hotel", summary: "" },
          },
        },
      ];
      show(false, "ask", Date.parse("2026-11-10T12:00:05Z"));
      const card = (await screen.findByText("Approved")).closest("button")!;
      expect(card.textContent).toContain("Send the draft");
      expect(screen.queryByText("Book the hotel")).toBeNull();
    });

    it("says an approval the guardian rejected", async () => {
      allApprovals = [decided("rejected", "dev")];
      await folded("Rejected");
    });

    it("says an approval Rome turned down when the wait ran out", async () => {
      allApprovals = [decided("rejected", "rome:task-ended")];
      await folded("Turned down: no answer within a day");
    });

    it("says an approval Rome turned down because its task was stopped", async () => {
      allApprovals = [decided("rejected", "rome:task-stopped")];
      await folded("Turned down: task stopped");
    });

    it("says a copy shown again still waits, for the card below, rather than claim an answer", async () => {
      allApprovals = [decided("pending", "")];
      waiting = true;
      show(false, "ask");
      expect(await screen.findByText("Waiting: answer the card below")).toBeTruthy();
      expect(screen.queryByText(/^Answered/)).toBeNull();
    });

    it("says it in Chinese too", async () => {
      await i18n.changeLanguage("zh-CN");
      allApprovals = [decided("rejected", "rome:task-ended")];
      waiting = false;
      show(true, "ask");
      expect(await screen.findByText("已自动拒绝：一天内没有回应")).toBeTruthy();
    });
  });

  it("keeps the task card to its title, status, Stop and Open, with no question inside", async () => {
    show(true, "task");
    expect(await screen.findByText("Task chat · Needs you")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("Which tone?")).toBeNull();
  });
});

/** A Concierge message holding `block`, as Rome hands it out with its card. */
function served(id: string, block: Record<string, unknown>): ChatMessage {
  return {
    id,
    sessionId: "concierge",
    role: "assistant",
    content: JSON.stringify([{ ...block, card: cardNow() }]),
    createdAt: "2026-11-10T12:00:00Z",
  } as ChatMessage;
}

function TaskJumpHarness() {
  useChatSessions("all", "all");
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
            <div ref={setContent}>
              <div data-timeline-anchor="m-older">
                <ServedBlocks blocks={[older]} newest={false} />
              </div>
              <div data-timeline-anchor="m-latest">
                <ServedBlocks blocks={[latest]} />
              </div>
            </div>
            <div ref={setFloor} data-testid="task-floor">
              <ChatPendingCardJump
                scroller={scroller}
                content={content}
                floor={floor}
                currentReplyMessageIds={new Set(["unrelated-main-reply"])}
                waitingTaskMessageIds={waitingTaskCardMessages([
                  { ...served("m-older", older) },
                  { ...served("m-latest", latest) },
                ])}
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

describe("TaskChatCard width", () => {
  // jsdom lays nothing out, so the width is read from the classes: a message
  // bubble's cap for a card holding a question or an approval, the compact cap
  // for one that holds none.
  const BUBBLE = "max-w-[min(100%,var(--container-2xl))]";
  const WIDE = `has-[[data-chat-task-open]]:${BUBBLE}`;

  for (const kind of ["question", "approval"] as const) {
    const control = kind === "question" ? "Send" : "Approve";
    const what = kind === "question" ? "a question" : "an approval";
    const arrange = () => {
      if (kind === "approval") {
        messages = [];
        approvals = [approval()];
      }
    };

    it(`gives ${what} shown alone a message bubble's width`, async () => {
      arrange();
      show(true, "ask");
      await screen.findByRole("button", { name: control });
      const box = document.querySelector("[data-chat-task-waiting]")!.parentElement!;
      expect(box.className).toContain(BUBBLE);
      expect(box.className).not.toContain("max-w-md");
    });

    it(`opens ${what} inside a card from before to a message bubble's width`, async () => {
      arrange();
      show(true);
      await screen.findByRole("button", { name: control });
      const card = document
        .querySelector("[data-chat-task-open]")!
        .closest<HTMLElement>(".rounded-16")!;
      expect(card.className).toContain("max-w-md");
      expect(card.className).toContain(WIDE);
    });
  }

  it("keeps the task card, which holds no question, at the compact width", async () => {
    show(true, "task");
    await screen.findByText("Draft email");
    expect(document.querySelector("[data-chat-task-open]")).toBeNull();
    expect(screen.getByText("Draft email").closest(".rounded-16")?.className).toContain("max-w-md");
  });

  it("marks no open card for a card from before when the task holds nothing to answer", async () => {
    messages = [];
    show(true);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/chat/sessions?")),
      ).toBe(true),
    );
    await screen.findByText("Draft email");
    expect(document.querySelector("[data-chat-task-open]")).toBeNull();
  });
});

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
              <ServedBlocks blocks={[older, latest]} />
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
      // The task says what it waits on: no transcript is read for it.
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/messages")),
      ).toHaveLength(0);
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
    render(
      <QueryClientProvider client={client}>
        <TaskJumpHarness />
      </QueryClientProvider>,
    );
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
    // The question was answered in the task chat itself, so its card says so.
    messages.push(message("answer", [result], "user"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["chat-sessions"] });
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Needs you: jump to waiting card" })).toBeNull(),
    );
    expect(document.querySelector("[data-chat-pending-card]")).toBeNull();
  });

  it("shows the card its task waits on however far back it is, reading no transcript", async () => {
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
    expect(requests).toEqual([]);
  });

  it("shows the next card once its task waits on it, after its turn ran", async () => {
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
          render: questionCardRender([{ id: "next", question: "Next question?", type: "text" }]),
        },
      ]),
    ];
    // The task list hears of the new wait, as its live event tells it.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["chat-sessions"] });
    });
    notify(false);
    await screen.findByText("Next question?");
    expect(screen.queryByText("Which tone?")).toBeNull();
  });

  it("allows a later question in the same mounted card to be answered", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await screen.findByText("Sent");
    const nextQuestion = {
      ...question,
      toolUseId: "item_1",
      render: questionCardRender([
        { id: "next", question: "Next question?", type: "single", options: ["Yes"] },
      ]),
    };
    messages = [message("next", [nextQuestion])];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["chat-sessions"] });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Yes" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1][0]).toBe("/api/chat/widgets/next/events");
    expect(JSON.parse(String(posts()[1][1]?.body))).toMatchObject({
      name: "send",
      context: { answers: [{ values: ["Yes"], text: "" }] },
    });
  });

  it("shows the task's question and posts its answer to the task, not the main chat", async () => {
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Warm" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0];
    expect(url).toBe("/api/chat/widgets/ask/events");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: "send",
      context: { answers: [{ values: ["Warm"], text: "" }] },
    });
    // The turn is the task chat's, never with the Chat's persona or workspace.
    const turn = JSON.parse(String(init?.body)).turn;
    expect(turn.personaId).toBeUndefined();
    expect(turn.workspace).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(await screen.findByText("Sent")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(`/chat/${chatId}`);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/chat/sessions?"))
          .length,
      ).toBeGreaterThan(1),
    );
  });

  it("collapses after the refresh says the card was answered", async () => {
    postAction = () => {
      waiting = false;
      messages.push(message("answer", [result], "user"));
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
    expect(JSON.parse(String(posts()[0][1]?.body)).name).toBe("dismiss");
    expect(await screen.findByText("Sent")).toBeTruthy();
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
          render: questionCardRender([{ id: "again", question: "Ask again?", type: "text" }]),
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
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/chat/sessions?")),
      ).toBe(true),
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
    await screen.findByRole("button", { name: "Open the task chat to answer" });
    expect(screen.queryByText("Which tone?")).toBeNull();
    expect(screen.getByRole("link")).toBeTruthy();
  });

  it("folds a card its task left open when it ended, and takes no answer", async () => {
    waiting = false;
    taskRows = [
      {
        id: "task-9",
        title: "Draft email",
        state: "done",
        status: "ended",
        endReason: "done",
        chat: { id: chatId, name: "Draft email" },
        conciergeChat: { id: "concierge", name: "Concierge", main: true },
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    show(true, "ask");
    expect(await screen.findByText("Closed: the task ended")).toBeTruthy();
    expect(document.querySelector("[data-chat-task-waiting]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("draws the card its message carries, reading no transcript to find it", async () => {
    taskRows = [
      {
        id: "task-9",
        title: "Draft email",
        state: "needs_user",
        status: "needs_you",
        endReason: null,
        chat: { id: chatId, name: "Draft email" },
        conciergeChat: { id: "concierge", name: "Concierge", main: true },
        createdAt: 1,
        updatedAt: 2,
        openWait: {
          kind: "card",
          id: "item_0",
          messageId: "ask",
          render: question.type === "pending_interaction" ? question.render : null,
          since: 1,
        },
      },
    ];
    show(true, "ask");
    expect(await screen.findByText("Which tone?")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/messages"))).toBe(false);
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
    // The task waits on nothing any more, so the card goes with its error.
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

describe("TaskChatCard drawn from the card Rome filled in", () => {
  const renderCard = (card: TaskCard, live: Map<string, TaskCard> = new Map()) =>
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/chat/main-chat"]}>
          <LiveTaskCardsProvider value={live}>
            {renderFlatEntries([
              { type: "task_chat", chatId, title: "Task", show: "ask", card } as never,
            ])}
          </LiveTaskCardsProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it("shows one quiet line for a card Rome could not find, not an empty card", async () => {
    renderCard({ kind: "unavailable" });
    expect(
      await screen.findByText("This question or approval can no longer be shown"),
    ).toBeTruthy();
    expect(document.querySelector("[data-chat-settled-card]")).toBeNull();
  });

  it("shows how an approval was decided as soon as a live event settles it", async () => {
    waiting = false;
    const asked = {
      kind: "approval" as const,
      id: "approval-1",
      title: "Send the draft",
      actionName: "mail:send",
      since: 1,
    };
    const { rerender } = renderCard(asked);
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/chat/main-chat"]}>
          <LiveTaskCardsProvider
            value={
              new Map([[cardKey(asked), { ...asked, outcome: { kind: "rejected" as const } }]])
            }
          >
            {renderFlatEntries([
              { type: "task_chat", chatId, title: "Task", show: "ask", card: asked } as never,
            ])}
          </LiveTaskCardsProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Rejected")).toBeTruthy();
  });

  it("asks nothing of the server per card: no transcript pages and no approval list", async () => {
    waiting = false;
    renderCard({
      kind: "question",
      id: "item_0",
      messageId: "ask",
      render: question.type === "pending_interaction" ? question.render : null,
      since: 1,
      expired: false,
      outcome: {
        kind: "answered",
        answer: { text: "Warm", output: { answers: [{ value: "Warm" }] } },
      },
    });
    expect(await screen.findByText("Answered: Warm")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) => /\/messages|\/api\/approvals/.test(String(url))),
    ).toBe(false);
  });
});
