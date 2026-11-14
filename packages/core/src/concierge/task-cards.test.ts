import { describe, expect, it } from "@rstest/core";
import type { ConciergeTaskRow } from "../db/repositories/concierge-tasks.js";
import type { TaskChatCards } from "../webchat/repository.js";
import {
  cardAt,
  openCards,
  settledCard,
  type TaskCardSources,
  withTaskCards,
} from "./task-cards.js";

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
      closed: false,
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

  it("fills a card from before `show` with what its task chat asked last, not what it had asked then", async () => {
    const { read } = sources(new Map([["task-1", asked()]]));
    const [filled] = await withTaskCards(
      read,
      [message("c1", T + 60_000, [{ type: "task_chat", chatId: "task-1", title: "Draft" }])],
      "guardian",
    );
    expect(JSON.parse(filled!.content)[0].card).toMatchObject({ kind: "question", id: "q2" });
  });

  it("shows the item an ask card waited on, not a newer one asked and settled since", async () => {
    const cards: TaskChatCards = {
      questions: [],
      approvals: [
        {
          id: "older",
          status: "pending",
          resolvedBy: null,
          description: "Pay the bill",
          payload: {},
          since: T,
        },
        {
          id: "newer",
          status: "rejected",
          resolvedBy: "guardian",
          description: "Send the draft",
          payload: {},
          since: T + DAY,
        },
      ],
    };
    const { read } = sources(new Map([["task-1", cards]]));
    const waited = {
      ...ask(),
      waitedOn: { kind: "approval", id: "older" },
    };
    const [filled] = await withTaskCards(
      read,
      [message("c1", T + DAY + 60_000, [waited])],
      "guardian",
    );
    expect(JSON.parse(filled!.content)[0].card).toEqual({
      kind: "approval",
      id: "older",
      title: "Pay the bill",
      since: T,
      closed: false,
    });
  });

  it("matches a waited-on question by its message as well as its tool use id", async () => {
    const cards: TaskChatCards = {
      questions: [
        { id: "ask", messageId: "m1", render, since: T, output: { dismissed: true } },
        { id: "ask", messageId: "m2", render, since: T + DAY },
      ],
      approvals: [],
    };
    const { read } = sources(new Map([["task-1", cards]]));
    const waited = (messageId: string) => ({
      ...ask(),
      waitedOn: { kind: "question", id: "ask", messageId },
    });
    const filled = await withTaskCards(
      read,
      [message("c1", T + 60_000, [waited("m1")]), message("c2", T + DAY + 60_000, [waited("m2")])],
      "guardian",
    );
    expect(filled.map((each) => JSON.parse(each.content)[0].card)).toMatchObject([
      { messageId: "m1", outcome: { kind: "dismissed" } },
      { messageId: "m2" },
    ]);
    expect(JSON.parse(filled[1]!.content)[0].card.outcome).toBeUndefined();
  });

  it("shows nothing in a chat that is not a private Concierge chat", async () => {
    const { read } = sources(new Map([["task-1", asked()]]));
    const [filled] = await withTaskCards(read, [message("c1", T + 60_000, [ask()])], null);
    expect(JSON.parse(filled!.content)[0].card).toEqual({ kind: "unavailable" });
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

describe("a card whose task ended", () => {
  /** A task chat with one open question, one answered, one open approval and one decided. */
  const open = (): TaskChatCards => ({
    questions: [
      { id: "q1", messageId: "m1", render, since: T, output: { answers: [] } },
      { id: "q2", messageId: "m2", render, since: T + DAY },
    ],
    approvals: [
      {
        id: "a1",
        status: "pending",
        resolvedBy: null,
        description: "Send",
        payload: {},
        since: T + DAY,
      },
      {
        id: "a2",
        status: "approved",
        resolvedBy: null,
        description: "Post",
        payload: {},
        since: T,
      },
    ],
  });
  const row = (ended: boolean, expired = false) =>
    ({
      sessionId: "task-1",
      ownerKey: "guardian",
      endedAt: ended ? new Date(T + 2 * DAY) : null,
      expiredWaitAt: expired ? new Date(T + DAY) : null,
    }) as ConciergeTaskRow;
  const closedOf = async (r: ConciergeTaskRow) => {
    const { read } = sources(new Map([["task-1", open()]]), [r]);
    return Object.fromEntries(
      (await openCards(read, "task-1", { approvals: true })).map((card) => [card.id, card.closed]),
    );
  };

  it("closes every card still open once its task ended, and opens them if it starts again", async () => {
    expect(await closedOf(row(true))).toEqual({ q2: true, a1: true });
    expect(await closedOf(row(false))).toEqual({ q2: false, a1: false });
  });

  it("leaves a card with an outcome not closed, and closes an expired question", async () => {
    const { read } = sources(new Map([["task-1", open()]]), [row(true)]);
    expect(await settledCard(read, "task-1", { kind: "question", id: "q1" })).toMatchObject({
      closed: false,
    });
    expect(await settledCard(read, "task-1", { kind: "approval", id: "a2" })).toMatchObject({
      closed: false,
    });
    // A question nobody answered in time closes with its task too.
    expect(await closedOf(row(true, true))).toEqual({ q2: true, a1: true });
  });

  it("fills `closed` into the cards a page hands out", async () => {
    const { read } = sources(new Map([["task-1", open()]]), [row(true)]);
    const [filled] = await withTaskCards(
      read,
      [message("c1", T + DAY + 1_000, [{ ...ask(), waitedOn: { kind: "approval", id: "a1" } }])],
      "guardian",
    );
    expect(JSON.parse(filled!.content)[0].card).toMatchObject({ id: "a1", closed: true });
  });
});
