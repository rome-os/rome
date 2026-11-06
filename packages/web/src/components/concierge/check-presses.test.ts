import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChatMessage } from "@/lib/chat-types";
import { checkPresses } from "./check-presses";
import { beginPending, getPending, resetPending } from "./task-pending";

const chat = rs.hoisted(() => ({
  turns: [] as Array<{ turnId: string; agentTurnId?: string }>,
  messages: [] as Array<Partial<ChatMessage>>,
  /** A topic chat's own turns and messages. */
  topic: {
    turns: [] as Array<{ turnId: string; agentTurnId?: string }>,
    messages: [] as Array<Partial<ChatMessage>>,
  },
}));
rs.mock("@/lib/chat-api", () => ({
  listSessionTurns: async (id: string) => (id === "topic-1" ? chat.topic.turns : chat.turns),
  listSessionMessagePage: async (id: string) => ({
    messages: id === "topic-1" ? chat.topic.messages : chat.messages,
    nextCursor: null,
  }),
}));

const phases = () => Object.fromEntries([...getPending()].map(([id, press]) => [id, press.phase]));

beforeEach(() => {
  resetPending();
  chat.turns = [];
  chat.messages = [];
  chat.topic = { turns: [], messages: [] };
});
afterEach(() => resetPending());

describe("checkPresses", () => {
  it("marks only the press the ended turn took in, and leaves the one still queued pending", async () => {
    beginPending("first", "stop", 1, "input-first", "concierge");
    beginPending("second", "archive", 1, "input-second", "concierge");
    // Turn 1 took the first press in and has ended. The second press waits
    // for turn 2, which is queued, so no turn has handled it yet.
    chat.messages = [
      { id: "input-first", turnId: "turn-1", inputState: "consumed" },
      { id: "input-second", turnId: "turn-1", inputState: "queued" },
    ];
    chat.turns = [{ turnId: "turn-2" }];

    await checkPresses();

    expect(phases()).toEqual({ first: "unchanged", second: "pending" });
  });

  it("leaves a press pending while the turn that took it in still runs", async () => {
    beginPending("first", "stop", 1, "input-first", "concierge");
    chat.messages = [{ id: "input-first", turnId: "turn-1", inputState: "consumed" }];
    chat.turns = [{ turnId: "backend:x", agentTurnId: "turn-1" }];
    await checkPresses();
    expect(phases()).toEqual({ first: "pending" });
  });

  it("leaves a press pending when no turn has seen its message yet", async () => {
    beginPending("first", "stop", 1, "input-first", "concierge");
    chat.messages = [{ id: "input-first", turnId: null, inputState: "submitted" }];
    await checkPresses();
    expect(phases()).toEqual({ first: "pending" });
    chat.messages = [];
    await checkPresses();
    expect(phases()).toEqual({ first: "pending" });
  });

  it("marks each press by its own turn when several turns have ended", async () => {
    beginPending("first", "stop", 1, "input-first", "concierge");
    beginPending("second", "stop", 1, "input-second", "concierge");
    chat.messages = [
      { id: "input-first", turnId: "turn-1", inputState: "consumed" },
      { id: "input-second", turnId: "turn-2", inputState: "consumed" },
    ];
    chat.turns = [{ turnId: "turn-2" }];
    await checkPresses();
    expect(phases()).toEqual({ first: "unchanged", second: "pending" });
  });

  it("looks for each press in the Concierge chat it went to", async () => {
    beginPending("main-row", "stop", 1, "input-main", "concierge");
    beginPending("topic-row", "stop", 1, "input-topic", "topic-1");
    // Only the topic chat's turn has ended.
    chat.messages = [{ id: "input-main", turnId: "turn-1", inputState: "consumed" }];
    chat.turns = [{ turnId: "turn-1" }];
    chat.topic.messages = [{ id: "input-topic", turnId: "turn-9", inputState: "consumed" }];
    await checkPresses();
    expect(phases()).toEqual({ "main-row": "pending", "topic-row": "unchanged" });
  });
});
