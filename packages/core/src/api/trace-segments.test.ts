import { describe, it, expect } from "@rstest/core";
import {
  buildTraceSnapshot,
  createSegmentBuilder,
  agentMessageToBlock,
  type AppResolver,
  type TraceBlockDto,
  type TraceRunSegment,
  type TraceSegment,
} from "./trace-segments.js";
import type { AppRefDto, TraceAccounting } from "@rome/api-types/trace-segments";

// Tiny deterministic resolver for tests so we don't depend on the FNV hash
// rotation for parity assertions.
const APP_BY_TOOL: Record<string, AppRefDto> = {
  Edit: { id: "files", name: "Files", iconUrl: "/files.svg" },
  Read: { id: "files", name: "Files", iconUrl: "/files.svg" },
  Bash: { id: "terminal", name: "Terminal", iconUrl: "/terminal.svg" },
  Browse: { id: "browser", name: "Browser", iconUrl: "/browser.svg" },
};
const testResolver: AppResolver = {
  resolveTool(block) {
    const tool = block.type === "subagent_start" ? block.agentName : block.tool;
    return APP_BY_TOOL[tool] ?? { id: tool, name: tool, iconUrl: `/x.svg` };
  },
};

describe("agentMessageToBlock", () => {
  it("preserves machine-readable error recovery fields", () => {
    expect(
      agentMessageToBlock({
        type: "error",
        error: "Selected model provider is unavailable: Codex",
        code: "model_provider_unavailable",
        provider: "openai",
        reason: "not_logged_in",
      }),
    ).toMatchObject({
      type: "error",
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
  });

  it("preserves first-class subagent lifecycle blocks", () => {
    expect(
      agentMessageToBlock({
        type: "subagent_result",
        toolUseId: "tool-1",
        agentName: "planning",
        status: "completed",
        sessionId: "child-session",
        turnId: "child-turn",
        output: { plan: "done" },
      }),
    ).toMatchObject({
      type: "subagent_result",
      agentName: "planning",
      status: "completed",
      sessionId: "child-session",
      turnId: "child-turn",
      output: { plan: "done" },
    });
  });
});

function toolUse(tool: string, agent = "main", startedAt?: string): TraceBlockDto {
  return { type: "tool_use", tool, input: {}, agent, startedAt };
}
function toolUseWithId(
  tool: string,
  id: string,
  agent = "main",
  startedAt?: string,
): TraceBlockDto {
  return { type: "tool_use", tool, input: {}, id, agent, startedAt };
}
function toolResult(tool: string, agent = "main", endedAt?: string): TraceBlockDto {
  return { type: "tool_result", tool, output: "ok", agent, endedAt };
}
function toolResultWithId(
  tool: string,
  toolUseId: string,
  agent = "main",
  endedAt?: string,
): TraceBlockDto {
  return { type: "tool_result", tool, output: "ok", toolUseId, agent, endedAt };
}
function text(content: string, agent = "main"): TraceBlockDto {
  return { type: "text", content, agent };
}
function accounting(overrides: Partial<TraceAccounting> = {}): TraceAccounting {
  return {
    provider: "test",
    model: "test",
    usage: {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    ...overrides,
  };
}
function result(durationMs?: number, agent = "main"): TraceBlockDto {
  return {
    type: "result",
    content: "done",
    agent,
    ...(durationMs !== undefined ? { accounting: accounting({ durationMs }) } : {}),
  };
}
function turnEnd(
  durationMs: number,
  agent = "main",
  status: "completed" | "interrupted" | "error" = "completed",
): TraceBlockDto {
  return { type: "turn_end", turnId: "turn-1", status, durationMs, agent };
}
function turnStart(agent = "main"): TraceBlockDto {
  return {
    type: "turn_start",
    turnId: "turn-2",
    sessionId: "session-1",
    userPrompt: "next",
    agent,
  };
}

function planUpdate(
  steps: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>,
): Extract<TraceBlockDto, { type: "plan_update" }> {
  return { type: "plan_update", plan: { steps }, agent: "main" };
}

function runs(segments: TraceSegment[]): TraceRunSegment[] {
  return segments.filter((s): s is TraceRunSegment => s.kind === "run");
}

describe("buildTraceSnapshot — run grouping", () => {
  it("merges adjacent same-app tool_uses into one run, preserves order across groups", () => {
    const blocks = [toolUse("Edit"), toolUse("Read"), toolUse("Bash"), toolUse("Edit")];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const r = runs(snap.segments);
    expect(r.map((x) => x.app.id)).toEqual(["files", "terminal", "files"]);
    expect(r.map((x) => x.count)).toEqual([2, 1, 1]);
  });

  it("A B B A → 4 runs (apps differ)", () => {
    const blocks = [toolUse("Edit"), toolUse("Bash"), toolUse("Bash"), toolUse("Edit")];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const r = runs(snap.segments);
    expect(r.map((x) => `${x.app.id}×${x.count}`)).toEqual(["files×1", "terminal×2", "files×1"]);
  });

  it("a non-tool block between same-app tool_uses splits the run", () => {
    const blocks = [toolUse("Edit"), text("hi"), toolUse("Read")];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const segs = snap.segments;
    expect(segs.map((s) => s.kind)).toEqual(["run", "block", "run"]);
    expect(runs(segs).map((r) => r.count)).toEqual([1, 1]);
  });

  it("raw agent metadata does not split a same-session run", () => {
    const blocks = [toolUse("Edit", "main"), toolUse("Edit", "envoy"), toolUse("Edit", "main")];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const r = runs(snap.segments);
    expect(r).toHaveLength(1);
    expect(r[0].count).toBe(3);
  });
});

describe("buildTraceSnapshot — pairing and durations", () => {
  it("pairs tool_result into the latest matching tool_use in the run", () => {
    const blocks = [
      toolUse("Edit", "main", "2026-01-01T00:00:00.000Z"),
      toolResult("Edit", "main", "2026-01-01T00:00:01.500Z"),
      toolUse("Edit", "main", "2026-01-01T00:00:02.000Z"),
      toolResult("Edit", "main", "2026-01-01T00:00:02.300Z"),
      result(),
      turnEnd(5000),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const r = runs(snap.segments);
    expect(r.length).toBe(1);
    expect(r[0].count).toBe(2);
    expect(r[0].durationMs).toBe(1800);
    expect(snap.summary.totalDurationMs).toBe(5000);
  });

  it("run durationMs is undefined when any step lacks timestamps", () => {
    const blocks = [
      toolUse("Edit", "main", "2026-01-01T00:00:00.000Z"),
      toolResult("Edit", "main", "2026-01-01T00:00:01.000Z"),
      toolUse("Edit", "main"), // no startedAt
      toolResult("Edit", "main", "2026-01-01T00:00:02.000Z"),
      result(),
      turnEnd(2300),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const r = runs(snap.segments);
    expect(r[0].durationMs).toBeUndefined();
    expect(snap.summary.totalDurationMs).toBe(2300);
  });

  it("pairs both results when parallel tool_uses share a turn (use, use, result, result)", () => {
    const blocks = [
      toolUse("Edit", "main", "2026-01-01T00:00:00.000Z"),
      toolUse("Edit", "main", "2026-01-01T00:00:00.100Z"),
      toolResult("Edit", "main", "2026-01-01T00:00:01.000Z"),
      toolResult("Edit", "main", "2026-01-01T00:00:01.500Z"),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const r = runs(snap.segments);
    expect(r.length).toBe(1);
    expect(r[0].count).toBe(2);
    const resultCount = r[0].blocks.filter((b) => b.type === "tool_result").length;
    expect(resultCount).toBe(2);
  });

  it("orphan tool_result without preceding tool_use is dropped", () => {
    const blocks = [text("hi"), toolResult("Edit"), text("bye")];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    expect(snap.segments.map((s) => s.kind)).toEqual(["block", "block"]);
  });

  it("pairs tool_result by id into a finalized run after a block boundary", () => {
    const blocks: TraceBlockDto[] = [
      toolUseWithId("Edit", "use-1", "main", "2026-01-01T00:00:00.000Z"),
      text("still working"),
      // The result arrives late, with the matching tool_use_id.
      toolResultWithId("Edit", "use-1", "main", "2026-01-01T00:00:02.500Z"),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const traceRuns = runs(snap.segments);
    expect(traceRuns).toHaveLength(1);
    expect(traceRuns[0].blocks.filter((b) => b.type === "tool_result")).toHaveLength(1);
    expect(traceRuns[0].durationMs).toBe(2500);
  });

  it("pairs first-class subagent lifecycle blocks", () => {
    const blocks: TraceBlockDto[] = [
      {
        type: "subagent_start",
        toolUseId: "subagent-use",
        agentName: "planning",
        input: { prompt: "plan" },
        sessionId: "child-session",
        turnId: "child-turn",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "subagent_result",
        toolUseId: "subagent-use",
        agentName: "planning",
        status: "completed",
        sessionId: "child-session",
        turnId: "child-turn",
        output: { plan: "done" },
        endedAt: "2026-01-01T00:00:01.000Z",
      },
    ];

    const snap = buildTraceSnapshot({ idPrefix: "t", blocks, resolver: testResolver });
    const subagentRun = runs(snap.segments)[0];

    expect(subagentRun.blocks.map((block) => block.type)).toEqual([
      "subagent_start",
      "subagent_result",
    ]);
    expect(subagentRun.durationMs).toBe(1000);
    expect(snap.summary.subagents).toEqual([
      {
        toolUseId: "subagent-use",
        agentName: "planning",
        sessionId: "child-session",
        turnId: "child-turn",
        status: "completed",
      },
    ]);
  });

  it("pairs by id correctly when results arrive out of call order", () => {
    const blocks: TraceBlockDto[] = [
      toolUseWithId("Edit", "u1", "main", "2026-01-01T00:00:00.000Z"),
      toolUseWithId("Edit", "u2", "main", "2026-01-01T00:00:00.100Z"),
      // Result for u2 arrives first.
      toolResultWithId("Edit", "u2", "main", "2026-01-01T00:00:00.500Z"),
      toolResultWithId("Edit", "u1", "main", "2026-01-01T00:00:01.500Z"),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const r = runs(snap.segments);
    expect(r).toHaveLength(1);
    expect(r[0].count).toBe(2);
    expect(r[0].blocks.filter((b) => b.type === "tool_result")).toHaveLength(2);
    expect(r[0].durationMs).toBe(1500 + 400);
  });

  it("run with no paired tool_result has undefined duration (not 0ms)", () => {
    const blocks = [toolUse("Edit", "main", "2026-01-01T00:00:00.000Z"), text("interrupted")];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const r = runs(snap.segments);
    expect(r).toHaveLength(1);
    expect(r[0].durationMs).toBeUndefined();
    expect(snap.summary.totalDurationMs).toBeUndefined();
  });
});

describe("buildTraceSnapshot — summary", () => {
  it("counts distinct apps in first-appearance order", () => {
    const blocks = [
      toolUse("Edit", "main"),
      toolUse("Bash", "envoy"),
      toolUse("Edit", "main"),
      toolUse("Browse", "main"),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    expect(snap.summary.distinctApps.map((a) => a.id)).toEqual(["files", "terminal", "browser"]);
    expect(snap.summary.totalSteps).toBe(4);
    expect(snap.summary.invocationCounts).toEqual({ files: 2, terminal: 1, browser: 1 });
  });

  it("empty trace produces empty snapshot", () => {
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks: [],
      resolver: testResolver,
    });
    expect(snap.segments).toEqual([]);
    expect(snap.summary.totalSteps).toBe(0);
    expect(snap.summary.distinctApps).toEqual([]);
    expect(snap.summary.stoppedByUser).toBeUndefined();
    expect(snap.summary.terminalError).toBeUndefined();
    expect(snap.summary.turnStatus).toBeUndefined();
  });

  it("error block followed by turn_end flags summary.terminalError for failed turns", () => {
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks: [
        { type: "error", error: "Access token expired", agent: "main" },
        turnEnd(500, "main", "error"),
      ],
      resolver: testResolver,
    });
    expect(snap.summary.terminalError).toBe("Access token expired");
    expect(snap.summary.stoppedByUser).toBeUndefined();
    expect(snap.summary.turnStatus).toBe("error");
  });

  it("interrupted turn with an error terminal is reported as stopped rather than failed", () => {
    // A user stop that the provider surfaced as an error block: the
    // AgentSession classifies it `interrupted` on the bracket, which wins
    // over the error terminal.
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks: [
        { type: "error", error: "Request was aborted", agent: "main" },
        turnEnd(500, "main", "interrupted"),
      ],
      resolver: testResolver,
    });
    expect(snap.summary.stoppedByUser).toBe(true);
    expect(snap.summary.terminalError).toBeUndefined();
    expect(snap.summary.turnStatus).toBe("interrupted");
  });

  it("turn_end with status 'interrupted' flags summary.stoppedByUser", () => {
    // Mirrors what AgentSession emits when the user clicks Stop: the bracket
    // carries the classification, so the builder never inspects the
    // terminal's accounting.
    const blocks: TraceBlockDto[] = [
      toolUse("Edit", "main", "2026-01-01T00:00:00.000Z"),
      { type: "result", content: "", agent: "main" },
      turnEnd(700, "main", "interrupted"),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    expect(snap.summary.stoppedByUser).toBe(true);
    expect(snap.summary.totalSteps).toBe(1);
    expect(snap.summary.turnStatus).toBe("interrupted");
  });

  it("turn_start clears the previous turn's terminal summary for the live trace", () => {
    // Mid-turn live state: turn 1 failed, turn 2 has started but not ended.
    // The summary must not keep showing turn 1's error/stopped pill.
    const blocks: TraceBlockDto[] = [
      { type: "error", error: "Access token expired", agent: "main" },
      turnEnd(700, "main", "error"),
      turnStart("main"),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    expect(snap.summary.terminalError).toBeUndefined();
    expect(snap.summary.stoppedByUser).toBeUndefined();
    expect(snap.summary.totalDurationMs).toBeUndefined();
    expect(snap.summary.turnStatus).toBeUndefined();
  });

  it("stoppedByUser resets when a later turn in the same trace completes normally", () => {
    const blocks: TraceBlockDto[] = [
      { type: "result", content: "", agent: "main" },
      turnEnd(700, "main", "interrupted"),
      { type: "result", content: "done", agent: "main" },
      turnEnd(900, "main"),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    expect(snap.summary.stoppedByUser).toBeUndefined();
    expect(snap.summary.totalDurationMs).toBe(900);
    expect(snap.summary.turnStatus).toBe("completed");
  });

  it("stoppedByUser resets when a later turn in the same trace fails", () => {
    const blocks: TraceBlockDto[] = [
      { type: "result", content: "", agent: "main" },
      turnEnd(700, "main", "interrupted"),
      { type: "error", error: "boom", agent: "main" },
      turnEnd(900, "main", "error"),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    expect(snap.summary.stoppedByUser).toBeUndefined();
    expect(snap.summary.terminalError).toBe("boom");
    expect(snap.summary.turnStatus).toBe("error");
  });

  it("result block with a non-interrupted stopReason leaves stoppedByUser unset", () => {
    const blocks: TraceBlockDto[] = [
      {
        type: "result",
        content: "done",
        accounting: accounting({ stopReason: "end_turn" }),
        agent: "main",
      },
      turnEnd(700, "main"),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    expect(snap.summary.stoppedByUser).toBeUndefined();
  });

  it("totalDurationMs reads the turn_end block, not summed tool durations", () => {
    const blocks: TraceBlockDto[] = [
      toolUseWithId("Edit", "u1", "main", "2026-01-01T00:00:00.000Z"),
      toolUseWithId("Edit", "u2", "main", "2026-01-01T00:00:00.100Z"),
      toolResultWithId("Edit", "u2", "main", "2026-01-01T00:00:00.500Z"),
      toolResultWithId("Edit", "u1", "main", "2026-01-01T00:00:01.500Z"),
      result(),
      turnEnd(1600),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const [run] = runs(snap.segments);
    expect(run.durationMs).toBe(1500 + 400);
    expect(snap.summary.totalDurationMs).toBe(1600);
  });

  it("turn_start and turn_end produce no renderable segments", () => {
    const blocks: TraceBlockDto[] = [
      { type: "turn_start", turnId: "turn-1", sessionId: "s", userPrompt: "hi", agent: "main" },
      toolUse("Edit", "main"),
      result(),
      turnEnd(900),
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    const blockTypes = snap.segments.map((s) => (s.kind === "block" ? s.block.type : s.kind));
    expect(blockTypes).not.toContain("turn_start");
    expect(blockTypes).not.toContain("turn_end");
    expect(snap.summary.totalDurationMs).toBe(900);
  });

  it("trace without a turn_end block leaves summary fields undefined", () => {
    const blocks: TraceBlockDto[] = [
      {
        type: "result",
        content: "ok",
        agent: "main",
        accounting: accounting({ durationMs: 1234 }),
      },
    ];
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    expect(snap.summary.totalDurationMs).toBeUndefined();
    expect(snap.summary.stoppedByUser).toBeUndefined();
    expect(snap.summary.terminalError).toBeUndefined();
  });
});

describe("createSegmentBuilder — live equals bulk", () => {
  it("incremental push() yields the same final snapshot as buildTraceSnapshot", () => {
    const blocks: TraceBlockDto[] = [
      toolUse("Edit", "main", "2026-01-01T00:00:00.000Z"),
      toolResult("Edit", "main", "2026-01-01T00:00:00.500Z"),
      text("midpoint"),
      toolUse("Bash", "envoy", "2026-01-01T00:00:01.000Z"),
      toolResult("Bash", "envoy", "2026-01-01T00:00:02.000Z"),
      toolUse("Edit", "main", "2026-01-01T00:00:03.000Z"),
      toolResult("Edit", "main", "2026-01-01T00:00:03.250Z"),
    ];
    const live = createSegmentBuilder({
      idPrefix: "t",
      resolver: testResolver,
    });
    for (const b of blocks) live.push(b);
    const liveSnap = live.snapshot();
    const bulkSnap = buildTraceSnapshot({
      idPrefix: "t",
      blocks,
      resolver: testResolver,
    });
    expect(liveSnap).toEqual(bulkSnap);
  });

  it("push() returns the segments that changed for upsert-by-id", () => {
    const builder = createSegmentBuilder({
      idPrefix: "t",
      resolver: testResolver,
    });
    const c1 = builder.push(toolUse("Edit"));
    expect(c1).toHaveLength(1);
    expect(c1[0].kind).toBe("run");
    const runId = c1[0].id;
    const c2 = builder.push(toolUse("Edit"));
    expect(c2).toHaveLength(1);
    expect(c2[0].id).toBe(runId);
    expect((c2[0] as TraceRunSegment).count).toBe(2);

    const c3 = builder.push(text("done"));
    // text ends the active run (no further tool_uses extend it) but doesn't
    // mutate the run's payload, so only the new block segment is in `changed`.
    const kinds = c3.map((s) => s.kind);
    expect(kinds).toEqual(["block"]);
  });
});

describe("buildTraceSnapshot — provider Plan projection", () => {
  it("replaces the latest Plan without adding segments or tool totals", () => {
    const blocks: TraceBlockDto[] = [
      toolUseWithId("Edit", "u1"),
      planUpdate([
        { text: "Inspect", status: "in_progress" },
        { text: "Implement", status: "pending" },
      ]),
      toolUseWithId("Read", "u2"),
      planUpdate([
        { text: "Inspect", status: "completed" },
        { text: "Implement", status: "in_progress" },
      ]),
    ];

    const snap = buildTraceSnapshot({ idPrefix: "t", blocks, resolver: testResolver });

    expect(snap.summary.plan).toEqual({
      steps: [
        { text: "Inspect", status: "completed" },
        { text: "Implement", status: "in_progress" },
      ],
    });
    expect(snap.summary.totalSteps).toBe(2);
    expect(snap.segments).toHaveLength(1);
    expect(runs(snap.segments)[0].count).toBe(2);
  });

  it("turn_start clears the previous turn Plan and turn_end preserves the current one", () => {
    const builder = createSegmentBuilder({ idPrefix: "t", resolver: testResolver });
    builder.push(planUpdate([{ text: "Old turn", status: "completed" }]));
    builder.push(turnStart());
    expect(builder.snapshot().summary.plan).toBeUndefined();

    const current = planUpdate([{ text: "Current turn", status: "in_progress" }]);
    builder.push(current);
    builder.push(turnEnd(500));
    expect(builder.snapshot().summary.plan).toEqual(current.plan);
  });

  it("an explicit empty Plan clears the visible steps while remaining durable", () => {
    const snap = buildTraceSnapshot({
      idPrefix: "t",
      blocks: [planUpdate([{ text: "Temporary", status: "in_progress" }]), planUpdate([])],
      resolver: testResolver,
    });

    expect(snap.summary.plan).toEqual({ steps: [] });
    expect(snap.segments).toEqual([]);
  });
});
