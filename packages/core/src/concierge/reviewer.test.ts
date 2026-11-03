import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { AgentEvent } from "@rome-os/app-runtime";

const logs = rs.hoisted(() => ({ warn: rs.fn(), info: rs.fn() }));
rs.mock("../logger.js", () => ({
  createLogger: () => ({ debug: rs.fn(), info: logs.info, warn: logs.warn, error: rs.fn() }),
}));

import {
  REVIEW_DEBOUNCE_MS,
  REVIEW_PROMPT,
  REVIEW_TIMEOUT_MS,
  TaskReviewer,
  type TaskReviewDeps,
} from "./reviewer.js";

/** A fork stream that ends when the test says so. */
function controlledFork(events: AgentEvent[] = []) {
  let finish: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let returned = false;
  const stream: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]() {
      const queue = [...events];
      return {
        async next() {
          if (queue.length > 0) return { value: queue.shift()!, done: false };
          await ended;
          return { value: undefined, done: true };
        },
        async return() {
          returned = true;
          return { value: undefined, done: true };
        },
      };
    },
  };
  return { stream, finish, wasReturned: () => returned };
}

/** A fork stream that ends after its events, as a real one ends after its terminal. */
async function* finishedFork(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  yield* events;
}

const ended: AgentEvent[] = [
  { type: "turn_start", turnId: "fork-turn", sessionId: "fork-session", userPrompt: "" },
  { type: "result", content: "Nothing changed." },
];

function setup(overrides: Partial<TaskReviewDeps> = {}) {
  const forks: Array<{ prompt: string; parentTurnId: string }> = [];
  let live = false;
  let enabled = true;
  let nextFork: () => AsyncIterable<AgentEvent> = () => finishedFork(ended);
  const reviewer = new TaskReviewer({
    isEnabled: async () => enabled,
    turnLive: () => live,
    fork: (prompt, parentTurnId) => {
      forks.push({ prompt, parentTurnId });
      return nextFork();
    },
    ...overrides,
  });
  return {
    reviewer,
    forks,
    setLive: (value: boolean) => {
      live = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    onFork: (make: () => AsyncIterable<AgentEvent>) => {
      nextFork = make;
    },
  };
}

describe("Concierge task review", () => {
  beforeEach(() => {
    rs.useFakeTimers();
    logs.info.mockClear();
    logs.warn.mockClear();
  });

  /** The outcome of each review, as its one log line says it. */
  const outcomes = () =>
    [...logs.info.mock.calls, ...logs.warn.mock.calls]
      .filter(([message]) => message === "concierge_task_review")
      .map(([, line]) => line);
  afterEach(() => {
    rs.useRealTimers();
  });

  it("forks once, 30 s after the last of a burst of turns, from that turn", async () => {
    const s = setup();
    s.reviewer.schedule("t1");
    await rs.advanceTimersByTimeAsync(20_000);
    s.reviewer.schedule("t2");
    await rs.advanceTimersByTimeAsync(20_000);
    s.reviewer.schedule("t3");
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS - 1);
    expect(s.forks).toEqual([]);
    await rs.advanceTimersByTimeAsync(1);
    expect(s.forks).toEqual([{ prompt: REVIEW_PROMPT, parentTurnId: "t3" }]);
    await rs.advanceTimersByTimeAsync(10 * REVIEW_DEBOUNCE_MS);
    expect(s.forks).toHaveLength(1);
  });

  it("skips while a Concierge turn is live, and the next turn end schedules it again", async () => {
    const s = setup();
    s.setLive(true);
    s.reviewer.schedule("t1");
    await rs.advanceTimersByTimeAsync(10 * REVIEW_DEBOUNCE_MS);
    expect(s.forks).toEqual([]);
    s.setLive(false);
    s.reviewer.schedule("t2");
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS);
    expect(s.forks.map((fork) => fork.parentTurnId)).toEqual(["t2"]);
  });

  it("runs one review at a time; a turn that ends during it gets its own review after", async () => {
    const s = setup();
    const first = controlledFork();
    s.onFork(() => first.stream);
    s.reviewer.schedule("t1");
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS);
    expect(s.forks).toHaveLength(1);
    s.reviewer.schedule("t2");
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS);
    expect(s.forks).toHaveLength(1);
    s.onFork(() => finishedFork(ended));
    first.finish();
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS);
    expect(s.forks.map((fork) => fork.parentTurnId)).toEqual(["t1", "t2"]);
  });

  it("does not retry a review that fails", async () => {
    const s = setup();
    s.onFork(() => {
      throw new Error("source session is not live");
    });
    s.reviewer.schedule("t1");
    await rs.advanceTimersByTimeAsync(10 * REVIEW_DEBOUNCE_MS);
    expect(s.forks).toHaveLength(1);
    s.onFork(() => finishedFork([{ type: "error", error: "provider down" }]));
    s.reviewer.schedule("t2");
    await rs.advanceTimersByTimeAsync(10 * REVIEW_DEBOUNCE_MS);
    expect(s.forks).toHaveLength(2);
    expect(outcomes()).toEqual([
      expect.objectContaining({ outcome: "failed", error: "source session is not live" }),
      expect.objectContaining({ outcome: "failed", error: "provider down" }),
    ]);
  });

  it("gives up a review that does not end in time, and closes its stream", async () => {
    const s = setup();
    const stuck = controlledFork();
    s.onFork(() => stuck.stream);
    s.reviewer.schedule("t1");
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS + REVIEW_TIMEOUT_MS);
    expect(stuck.wasReturned()).toBe(true);
    s.reviewer.schedule("t2");
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS);
    expect(s.forks).toHaveLength(2);
  });

  it("logs one line per review: rows the fork wrote, or nothing", async () => {
    const s = setup();
    s.onFork(() =>
      finishedFork([
        { type: "turn_start", turnId: "fork-turn", sessionId: "fork-session", userPrompt: "" },
        { type: "tool_use", id: "u1", tool: "task_list", input: { includeDone: true } },
        { type: "tool_result", toolUseId: "u1", tool: "task_list", output: "[]" },
        { type: "tool_use", id: "u2", tool: "mcp__rome__task_upsert", input: { tasks: [{}, {}] } },
        { type: "tool_result", toolUseId: "u2", tool: "mcp__rome__task_upsert", output: "ok" },
        { type: "result", content: "Fixed two rows." },
      ]),
    );
    s.reviewer.schedule("t1");
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS);
    s.onFork(() => finishedFork(ended));
    s.reviewer.schedule("t2");
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS);
    s.setLive(true);
    s.reviewer.schedule("t3");
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS);
    expect(outcomes()).toEqual([
      expect.objectContaining({
        sourceTurnId: "t1",
        forkSessionId: "fork-session",
        outcome: "wrote",
        rowsWritten: 2,
      }),
      expect.objectContaining({ sourceTurnId: "t2", outcome: "nothing", rowsWritten: 0 }),
      expect.objectContaining({ sourceTurnId: "t3", outcome: "skipped_live" }),
    ]);
  });

  it("does not fork once the setting is off, or after stop", async () => {
    const s = setup();
    s.setEnabled(false);
    s.reviewer.schedule("t1");
    await rs.advanceTimersByTimeAsync(REVIEW_DEBOUNCE_MS);
    s.setEnabled(true);
    s.reviewer.schedule("t2");
    s.reviewer.stop();
    await rs.advanceTimersByTimeAsync(10 * REVIEW_DEBOUNCE_MS);
    expect(s.forks).toEqual([]);
  });
});
