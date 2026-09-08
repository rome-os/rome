import { describe, expect, it } from "@rstest/core";
import type { TaskView } from "./fold.js";
import { hasBlockedLine, judge } from "./judge.js";

// The default judge reads the reply only, so the task it is handed never
// changes the verdict. One empty stand-in keeps that visible.
const TASK = {} as TaskView;

describe("judge", () => {
  it("accepts a worker that said something", () => {
    expect(judge(TASK, "Opened PR 88, CI green", "worker w1")).toEqual({ done: true });
  });

  it("rejects an empty reply", () => {
    const verdict = judge(TASK, "   \n  ", "worker w1");
    expect(verdict.done).toBe(false);
    expect(verdict.why).toBe("the worker returned an empty reply");
  });

  it("rejects a reply that declares itself blocked, and quotes the line", () => {
    const reply = ["Looked at the migration.", "BLOCKED: 0042 conflicts with 0041"].join("\n");
    expect(judge(TASK, reply, "worker w1")).toEqual({
      done: false,
      why: "BLOCKED: 0042 conflicts with 0041",
    });
  });

  it("ignores the word BLOCKED in the middle of a line", () => {
    expect(judge(TASK, "the queue was BLOCKED: it is not now", "worker w1").done).toBe(true);
  });

  it("reads a blocked line through leading whitespace", () => {
    expect(hasBlockedLine("  BLOCKED: no credentials")).toBe(true);
    expect(hasBlockedLine("all clear")).toBe(false);
  });
});
