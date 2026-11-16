import { describe, expect, it } from "@rstest/core";
import { type ScenarioRun, baselineMarkdown } from "./baseline-report.js";
import { type SpanRow, taskPath } from "./task-path.js";

const run = (version: number, config = "opus-low"): ScenarioRun => ({
  id: "qa-units",
  row: "simple-qa",
  config,
  model: "claude-opus-5-5",
  effort: "low",
  run: 1,
  version,
  chatId: "c",
  seconds: 3,
  resultMs: null,
  turns: [],
  notes: [],
  verdict: { score: 5, why: "" },
  transcript: [],
});

describe("baselineMarkdown", () => {
  it("keeps runs of a changed scenario apart, and says so", () => {
    const md = baselineMarkdown([run(1), run(2)]);
    expect(md).toContain("| opus-low (v1) |");
    expect(md).toContain("| opus-low (v2) |");
    expect(md).toContain("changed between runs (versions 1, 2)");
  });

  it("labels nothing when every run has one version", () => {
    const md = baselineMarkdown([run(2), run(2, "sonnet-low")]);
    expect(md).toContain("| opus-low |");
    expect(md).not.toContain("changed between runs");
  });
});

const span = (over: Partial<SpanRow>): SpanRow => ({
  trace: "t1",
  name: "tool",
  start: 0,
  ms: 0,
  agent: "",
  tool: "",
  outcome: "",
  subagent: "",
  model: "",
  thread: "",
  ...over,
});

describe("taskPath", () => {
  it("counts the task's session acquire once, not the model open it encloses", () => {
    const rows = [
      span({ thread: "webchat:con", name: "tool", tool: "chat_start", start: 1_000, ms: 100 }),
      span({
        name: "session.acquire",
        agent: "core:main",
        subagent: "false",
        start: 1_100,
        ms: 1_000,
      }),
      span({
        name: "model.session.open",
        agent: "core:main",
        subagent: "false",
        start: 1_150,
        ms: 800,
      }),
      span({
        name: "agent:core:main",
        agent: "core:main",
        thread: "webchat:task",
        start: 2_100,
        ms: 5_000,
      }),
      // A subagent's own open, inside the task, is no part of the task's start.
      span({
        name: "session.acquire",
        agent: "assistant:explore",
        subagent: "true",
        start: 3_000,
        ms: 400,
      }),
    ];
    const path = taskPath(rows, "con", "task", 0);
    expect(path.taskOpenMs).toBe(1_000);
    expect(path.toChatStartMs).toBe(1_100);
  });
});

describe("taskPath subagent calls", () => {
  it("gives each of two overlapping calls its own child and model", () => {
    const rows = [
      span({
        name: "agent:core:main",
        agent: "core:main",
        thread: "webchat:task",
        start: 0,
        ms: 10_000,
      }),
      span({ name: "tool", tool: "sa_explore", thread: "webchat:task", start: 1_000, ms: 4_000 }),
      span({ name: "tool", tool: "sa_research", thread: "webchat:task", start: 1_200, ms: 5_000 }),
      span({
        name: "agent:assistant:explore",
        agent: "assistant:explore",
        start: 1_050,
        ms: 3_000,
      }),
      span({
        name: "model.turn",
        agent: "assistant:explore",
        model: "claude-haiku-5-5",
        start: 1_100,
        ms: 2_000,
      }),
      span({ name: "agent:core:research", agent: "core:research", start: 1_250, ms: 4_000 }),
      span({
        name: "model.turn",
        agent: "core:research",
        model: "claude-opus-5-5",
        start: 1_300,
        ms: 3_000,
      }),
    ];
    const calls = taskPath(rows, "con", "task", 0).subagentCalls;
    expect(calls).toMatchObject([
      { tool: "sa_explore", agent: "assistant:explore", model: "claude-haiku-5-5", parallel: true },
      { tool: "sa_research", agent: "core:research", model: "claude-opus-5-5", parallel: true },
    ]);
  });
});
