import { describe, expect, it } from "@rstest/core";
import { type ScenarioRun, baselineMarkdown } from "./baseline-report.js";
import { type SpanRow, subagentToolName, taskPath } from "./task-path.js";

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

const guardianTurn = (turnId: string, firstSayMs: number) => ({
  chatId: "c",
  turnId,
  trigger: "guardian" as const,
  model: null,
  effort: null,
  session: "warm" as const,
  startMs: null,
  workingMs: null,
  reactedMs: null,
  firstSayMs,
  ackMs: firstSayMs,
  durationMs: firstSayMs,
  modelCalls: 1,
  toolCalls: 1,
  tools: { say: 1 },
  contextTokens: 80_000,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  failed: false,
  at: "",
});

describe("baselineMarkdown", () => {
  it("keeps runs of a changed scenario apart, and says so", () => {
    const md = baselineMarkdown([run(1), run(2)]);
    expect(md).toContain("| opus-low (v1) |");
    expect(md).toContain("| opus-low (v2) |");
    expect(md).toContain("changed between runs (versions 1, 2)");
  });

  it("counts rule notes apart from the checks, and times no setup turn", () => {
    const md = baselineMarkdown([
      {
        ...run(4),
        id: "long-context",
        row: "long-context",
        lang: "en",
        turns: [guardianTurn("setup", 60_000), guardianTurn("asked", 2_000)],
        setupTurnIds: ["setup"],
        notes: ['rule: 2 emoji in "x"'],
        measures: { contextTokens: 80_000 },
      },
    ]);
    expect(md).toContain(
      "| opus-low | 1 | 1/1 | 1 | 0 | 0 | 5.00 (1) | – | – / – | 2.0 / 2.0 | – |",
    );
    expect(md).toContain("## Rule regressions");
    expect(md).toContain('- opus-low r1 long-context: 2 emoji in "x"');
    expect(md).toContain("| opus-low | 1 | 80000 |");
    expect(md).not.toContain("60.0");
  });

  it("gives each scenario version its own overview row, and times no hand-off as inline", () => {
    const md = baselineMarkdown([
      {
        ...run(4),
        row: "reasoning",
        turns: [{ ...guardianTurn("t1", 9_000), tools: { chat_start: 1 } }],
      },
      { ...run(5), row: "simple-qa", turns: [guardianTurn("t2", 2_000)] },
    ]);
    expect(md).toContain("| opus-low (v4) | 1 | 1/1 | 0 | 0 | 0 | 5.00 (1) | – | – / – |");
    expect(md).toContain("| opus-low (v5) | 1 | 1/1 | 0 | 0 | 0 | 5.00 (1) | – | 2.0 / 2.0 |");
    expect(md).toContain("The runs span scenario versions 4, 5");
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
    const explore = subagentToolName("assistant:explore");
    const research = subagentToolName("core:research");
    const main = { agent: "core:main", thread: "webchat:task" };
    const rows = [
      span({ ...main, name: "agent:core:main", start: 0, ms: 10_000 }),
      span({ thread: "webchat:task", tool: explore, start: 1_000, ms: 4_000 }),
      span({ thread: "webchat:task", tool: research, start: 1_200, ms: 5_000 }),
      // The second call's child starts first: names, not order, match them.
      span({
        name: "agent:assistant:explore",
        agent: "assistant:explore",
        start: 1_300,
        ms: 3_000,
      }),
      span({
        name: "model.turn",
        agent: "assistant:explore",
        model: "haiku",
        start: 1_350,
        ms: 2_000,
      }),
      span({ name: "agent:core:research", agent: "core:research", start: 1_210, ms: 4_000 }),
      span({ name: "model.turn", agent: "core:research", model: "opus", start: 1_220, ms: 3_000 }),
    ];
    expect(taskPath(rows, "con", "task", 0).subagentCalls).toMatchObject([
      { tool: explore, agent: "assistant:explore", model: "haiku", parallel: true },
      { tool: research, agent: "core:research", model: "opus", parallel: true },
    ]);
  });
});
