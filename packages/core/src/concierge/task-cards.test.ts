import { describe, expect, it } from "@rstest/core";
import type { ConciergeTaskRow } from "../db/repositories/concierge-tasks.js";
import type { TaskChatCards } from "../webchat/repository.js";
import { cardAt, settledCard, type TaskCardSources, withTaskCards } from "./task-cards.js";

const DAY = 24 * 60 * 60 * 1000;
const T = Date.UTC(2026, 10, 12, 9);
const render = {
  builtin: true,
  componentId: "question-card",
  props: { questions: [{ question: "Which tone?" }] },
};

const asked = (): TaskChatCards => ({
  questions: [
    {
      id: "q1",
      messageId: "m1",
      render,
      since: T,
      output: { answers: [{ questionId: "tone", value: "Warm" }] },
    },
    { id: "q2", messageId: "m2", render, since: T + 2 * DAY },
  ],
  approvals: [
    {
      id: "a1",
      status: "rejected",
      resolvedBy: "rome:task-ended",
      description: "Send the draft",
      payload: {
        actionName: "mail:send",
        preview: { kind: "generic", title: "Send it", summary: "" },
      },
      since: T + DAY,
    },
  ],
});

const message = (id: string, at: number, parts: unknown[]) => ({
  id,
  role: "assistant",
  content: JSON.stringify(parts),
  createdAt: new Date(at),
});
const ask = (chatId = "task-1") => ({ type: "task_chat", chatId, title: "Draft", show: "ask" });

/** The task row of task chat `chatId`, its owner's. */
const taskOf = (chatId: string, ownerKey = "guardian") =>
  ({ sessionId: chatId, ownerKey, expiredWaitAt: null }) as ConciergeTaskRow;

function sources(
  cards: Map<string, TaskChatCards>,
  rows: ConciergeTaskRow[] = [...cards.keys()].map((chatId) => taskOf(chatId)),
) {
  const reads = { cards: 0, rows: 0 };
  const read: TaskCardSources = {
    taskCardsOf: async (chatIds) => {
      reads.cards += 1;
      return new Map(chatIds.flatMap((id) => (cards.has(id) ? [[id, cards.get(id)!]] : [])));
    },
    findBySessions: async () => {
      reads.rows += 1;
      return rows;
    },
    waitExpiry: DAY,
  };
  return { read, reads };
}

describe("cardAt", () => {
  it("shows what the task chat asked by the card's time, with how it ended", () => {
    expect(cardAt(asked(), T + 60_000, undefined, DAY)).toMatchObject({
      kind: "question",
      id: "q1",
      expired: false,
      outcome: { kind: "answered", answer: { text: "Warm" } },
    });
    expect(cardAt(asked(), T + DAY + 60_000, undefined, DAY)).toEqual({
      kind: "approval",
      id: "a1",
      title: "Send it",
      actionName: "mail:send",
      preview: { kind: "generic", title: "Send it", summary: "" },
      since: T + DAY,
      outcome: { kind: "turned_down", reason: "no_response" },
    });
  });

  it("marks a question nobody answered within its wait expired", () => {
    const row = { sessionId: "task-1", expiredWaitAt: new Date(T + 2 * DAY) } as ConciergeTaskRow;
    expect(cardAt(asked(), T + 3 * DAY, row, DAY)).toMatchObject({ id: "q2", expired: true });
    expect(cardAt(asked(), T + 3 * DAY, undefined, DAY)).toMatchObject({
      id: "q2",
      expired: false,
    });
  });

  it("is unavailable when the task chat had asked nothing by then", () => {
    expect(cardAt(asked(), T - DAY, undefined, DAY)).toEqual({ kind: "unavailable" });
    expect(cardAt(undefined, T, undefined, DAY)).toEqual({ kind: "unavailable" });
  });
});

describe("withTaskCards", () => {
  it("fills every ask card of a page in one read of each kind, however far back its question is", async () => {
    const { read, reads } = sources(
      new Map([
        ["task-1", asked()],
        ["task-2", asked()],
      ]),
    );
    const page = [
      message("c1", T + 60_000, [ask("task-1")]),
      message("c2", T + 2 * DAY + 60_000, [{ type: "text", content: "Here" }, ask("task-2")]),
      message("c3", T, [{ type: "text", content: "plain" }]),
      message("c4", T, [{ type: "task_chat", chatId: "task-1", title: "Draft", show: "task" }]),
    ];
    const filled = await withTaskCards(read, page, "guardian");
    expect(reads).toEqual({ cards: 1, rows: 1 });
    expect(JSON.parse(filled[0]!.content)[0].card).toMatchObject({ kind: "question", id: "q1" });
    expect(JSON.parse(filled[1]!.content)[1].card).toMatchObject({ kind: "question", id: "q2" });
    // A message with no ask card is handed back as it was.
    expect(filled[2]).toBe(page[2]);
    expect(filled[3]).toBe(page[3]);
  });

  it("shows a card whose read failed as unavailable, not an empty card", async () => {
    const read: TaskCardSources = {
      taskCardsOf: async () => {
        throw new Error("database is locked");
      },
      findBySessions: async () => [],
      waitExpiry: DAY,
    };
    const [filled] = await withTaskCards(read, [message("c1", T, [ask()])], "guardian");
    expect(JSON.parse(filled!.content)[0].card).toEqual({ kind: "unavailable" });
  });

  it("fills a card from before, which shows its task chat's question inside", async () => {
    const { read } = sources(new Map([["task-1", asked()]]));
    const [filled] = await withTaskCards(
      read,
      [message("c1", T + 60_000, [{ type: "task_chat", chatId: "task-1", title: "Draft" }])],
      "guardian",
    );
    expect(JSON.parse(filled!.content)[0].card).toMatchObject({ kind: "question", id: "q1" });
  });

  it("shows nothing of a chat that is not the reader's own task chat", async () => {
    const { read } = sources(
      new Map([
        ["task-1", asked()],
        ["visitor-task", asked()],
      ]),
      [taskOf("task-1"), taskOf("visitor-task", "visitor:acct-v")],
    );
    const filled = await withTaskCards(
      read,
      [
        message("c1", T + 60_000, [ask("visitor-task")]),
        message("c2", T + 60_000, [ask("no-task-chat")]),
      ],
      "guardian",
    );
    expect(filled.map((each) => JSON.parse(each.content)[0].card)).toEqual([
      { kind: "unavailable" },
      { kind: "unavailable" },
    ]);
  });
});

describe("cardAt and the card's own second", () => {
  it("counts what was asked in the card's second, and nothing from the second after", () => {
    const at = T + 500;
    const cards: TaskChatCards = {
      questions: [
        { id: "same", messageId: "m1", render, since: T },
        { id: "next", messageId: "m2", render, since: T + 1_000 },
      ],
      approvals: [],
    };
    expect(cardAt(cards, at, undefined, DAY)).toMatchObject({ id: "same" });
  });
});

describe("settledCard", () => {
  it("reads a settled question or approval as it stands now", async () => {
    const { read } = sources(new Map([["task-1", asked()]]));
    expect(await settledCard(read, "task-1", { kind: "approval", id: "a1" })).toMatchObject({
      outcome: { kind: "turned_down", reason: "no_response" },
    });
    expect(await settledCard(read, "task-1", { kind: "question", id: "q1" })).toMatchObject({
      outcome: { kind: "answered" },
    });
    expect(await settledCard(read, "task-1", { kind: "question", id: "nope" })).toBeNull();
  });
});
