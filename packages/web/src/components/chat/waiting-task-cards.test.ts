import { describe, expect, it } from "@rstest/core";
import type { TaskCard } from "@rome/api-types/chat";
import type { ChatMessage } from "@/lib/chat-types";
import { cardWaits, waitingTaskCardMessages } from "./waiting-task-cards";
import { cardKey } from "./entries/live-task-cards";

const question = (id: string, extra: Partial<TaskCard> = {}): TaskCard =>
  ({
    kind: "question",
    id,
    messageId: `m-${id}`,
    render: null,
    since: 1,
    expired: false,
    closed: false,
    ...extra,
  }) as TaskCard;
const message = (id: string, chatId: string, card?: TaskCard): ChatMessage =>
  ({
    id,
    sessionId: "concierge",
    role: "assistant",
    content: JSON.stringify([
      { type: "task_chat", chatId, title: "T", show: "ask", ...(card ? { card } : {}) },
    ]),
    createdAt: "2026-11-10T12:00:00Z",
  }) as ChatMessage;

describe("cardWaits", () => {
  it("waits while the card has no outcome, did not expire and was not closed", () => {
    expect(cardWaits(question("q"))).toBe(true);
    expect(cardWaits(question("q", { outcome: { kind: "dismissed" } }))).toBe(false);
    expect(cardWaits(question("q", { expired: true }))).toBe(false);
    expect(cardWaits(question("q", { closed: true }))).toBe(false);
    expect(cardWaits({ kind: "unavailable" })).toBe(false);
    expect(cardWaits(undefined)).toBe(false);
  });

  it("reads a card from a server before `closed` by its outcome alone", () => {
    const { closed: _closed, ...old } = question("q") as Extract<TaskCard, { kind: "question" }>;
    expect(cardWaits(old)).toBe(true);
  });
});

describe("waitingTaskCardMessages", () => {
  it("names the newest card of each task chat when that card waits, reading no task list", () => {
    const messages = [
      message("old", "c1", question("q0")),
      message("new", "c1", question("q1")),
      message("closed", "c2", question("q2", { closed: true })),
    ];
    expect([...waitingTaskCardMessages(messages)]).toEqual(["new"]);
  });

  it("counts a card whose body has not drawn yet, and none once a live event settled or closed it", () => {
    const card = question("q1");
    const messages = [message("new", "c1", card)];
    expect([...waitingTaskCardMessages(messages)]).toEqual(["new"]);
    const settled = new Map([
      [cardKey(card), { ...card, outcome: { kind: "dismissed" as const } } as TaskCard],
    ]);
    expect([...waitingTaskCardMessages(messages, settled)]).toEqual([]);
    const closed = new Map([[cardKey(card), { ...card, closed: true } as TaskCard]]);
    expect([...waitingTaskCardMessages(messages, closed)]).toEqual([]);
  });

  it("counts none without a card", () => {
    expect([...waitingTaskCardMessages([message("b", "c2")])]).toEqual([]);
  });
});
