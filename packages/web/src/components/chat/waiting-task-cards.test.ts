import { describe, expect, it } from "@rstest/core";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import type { TaskCard } from "@rome/api-types/chat";
import type { ChatMessage } from "@/lib/chat-types";
import { waitingTaskCardMessages } from "./waiting-task-cards";
import { cardKey } from "./entries/live-task-cards";

const question = (id: string): TaskCard => ({
  kind: "question",
  id,
  messageId: `m-${id}`,
  render: null,
  since: 1,
  expired: false,
});
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
const task = (chatId: string, status: string, openWait: unknown): ConciergeTaskDto =>
  ({ id: `task-${chatId}`, chat: { id: chatId }, status, openWait }) as ConciergeTaskDto;

describe("waitingTaskCardMessages", () => {
  it("names the newest card of each task that needs its owner for that very card", () => {
    const messages = [
      message("old", "c1", question("q0")),
      message("new", "c1", question("q1")),
      message("other", "c2", question("q2")),
    ];
    const tasks = [
      task("c1", "needs_you", { kind: "card", id: "q1", messageId: "m-q1", since: 1 }),
      task("c2", "active", null),
    ];
    expect([...waitingTaskCardMessages(messages, tasks)]).toEqual(["new"]);
  });

  it("counts a card whose body has not drawn yet, and none once a live event settled it", () => {
    const card = question("q1");
    const messages = [message("new", "c1", card)];
    const tasks = [
      task("c1", "needs_you", { kind: "card", id: "q1", messageId: "m-q1", since: 1 }),
    ];
    expect([...waitingTaskCardMessages(messages, tasks)]).toEqual(["new"]);
    const settled = new Map([
      [cardKey(card), { ...card, outcome: { kind: "dismissed" as const } }],
    ]);
    expect([...waitingTaskCardMessages(messages, tasks, settled)]).toEqual([]);
  });

  it("counts no older card that shares the waited-on question's tool use id", () => {
    const older: TaskCard = { ...question("q1"), messageId: "m-older" };
    const tasks = [
      task("c1", "needs_you", { kind: "card", id: "q1", messageId: "m-newer", since: 1 }),
    ];
    expect([...waitingTaskCardMessages([message("old", "c1", older)], tasks)]).toEqual([]);
  });

  it("counts no card the task does not wait on, and none without a card", () => {
    expect([
      ...waitingTaskCardMessages(
        [message("a", "c1", question("q1")), message("b", "c2")],
        [
          task("c1", "needs_you", { kind: "card", id: "other", since: 1 }),
          task("c2", "needs_you", null),
        ],
      ),
    ]).toEqual([]);
  });
});
