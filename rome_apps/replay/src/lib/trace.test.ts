import { describe, expect, it } from "@rstest/core";
import {
  blockToAgentMessage,
  isTerminalBlock,
  parseTrace,
  summarizeTrace,
  TraceParseError,
  type TraceBlock,
} from "./trace.js";

// A representative single-turn trace, shaped like a real downloaded trace.json.
const SAMPLE: TraceBlock[] = [
  { type: "session_init", sessionId: "s1", userPrompt: "hello there" },
  { type: "turn_start", turnId: "t1", sessionId: "s1", userPrompt: "what is 2+2?" },
  { type: "thinking", content: "Let me compute." },
  {
    type: "tool_use",
    id: "tu_1",
    tool: "calc",
    input: { expr: "2+2" },
    startedAt: "2026-01-01T00:00:00Z",
  },
  {
    type: "tool_result",
    toolUseId: "tu_1",
    tool: "calc",
    output: 4,
    endedAt: "2026-01-01T00:00:01Z",
  },
  { type: "text", content: "The answer is 4.", turnPhase: "final" },
  {
    type: "result",
    content: "The answer is 4.",
    accounting: { provider: "anthropic", model: "claude-opus-4-8", durationMs: 1234 },
  },
  { type: "turn_end", turnId: "t1", status: "completed", durationMs: 2000 },
];

const sampleJson = JSON.stringify(SAMPLE);

describe("parseTrace", () => {
  it("accepts a well-formed trace array and preserves order", () => {
    const { blocks } = parseTrace(sampleJson);
    expect(blocks).toHaveLength(SAMPLE.length);
    expect(blocks[1].type).toBe("turn_start");
  });

  it("rejects non-JSON", () => {
    expect(() => parseTrace("not json")).toThrow(TraceParseError);
  });

  it("rejects a non-array top level", () => {
    expect(() => parseTrace(JSON.stringify({ type: "text" }))).toThrow(/array/i);
  });

  it("rejects an unknown block type", () => {
    expect(() => parseTrace(JSON.stringify([{ type: "bogus" }]))).toThrow(/unknown type/i);
  });

  it("accepts Plan update blocks", () => {
    const plan = {
      type: "plan_update",
      plan: { steps: [{ text: "Inspect", status: "in_progress" }] },
    };
    expect(parseTrace(JSON.stringify([plan])).blocks).toEqual([plan]);
  });

  it("accepts first-class subagent lifecycle blocks", () => {
    const blocks = [
      {
        type: "subagent_start",
        toolUseId: "subagent-1",
        agentName: "researcher",
        input: { task: "Investigate" },
        sessionId: "recorded-child-session",
        turnId: "recorded-child-turn",
      },
      {
        type: "subagent_result",
        toolUseId: "subagent-1",
        agentName: "researcher",
        sessionId: "recorded-child-session",
        turnId: "recorded-child-turn",
        status: "completed",
        output: { result: "Done" },
      },
    ];
    expect(parseTrace(JSON.stringify(blocks)).blocks).toEqual(blocks);
  });
});

describe("summarizeTrace", () => {
  it("extracts prompt, status, model and duration", () => {
    const s = summarizeTrace(SAMPLE);
    expect(s.originalUserPrompt).toBe("what is 2+2?");
    expect(s.status).toBe("completed");
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.durationMs).toBe(2000);
    expect(s.blockCount).toBe(SAMPLE.length);
  });

  it("falls back to session_init.userPrompt when turn_start is absent", () => {
    const s = summarizeTrace([{ type: "session_init", sessionId: "s", userPrompt: "fallback" }]);
    expect(s.originalUserPrompt).toBe("fallback");
  });
});

describe("blockToAgentMessage", () => {
  it("drops lifecycle blocks", () => {
    expect(blockToAgentMessage({ type: "session_init", sessionId: "s" }, 0)).toBeNull();
    expect(blockToAgentMessage({ type: "turn_start" } as TraceBlock, 0)).toBeNull();
    expect(blockToAgentMessage({ type: "turn_end" } as TraceBlock, 0)).toBeNull();
  });

  it("maps content blocks back to AgentMessages", () => {
    const tu = blockToAgentMessage(SAMPLE[3], 3);
    expect(tu).toMatchObject({ type: "tool_use", id: "tu_1", tool: "calc" });
    const text = blockToAgentMessage(SAMPLE[5], 5);
    expect(text).toMatchObject({ type: "text", content: "The answer is 4.", turnPhase: "final" });
    const result = blockToAgentMessage(SAMPLE[6], 6);
    expect(result).toMatchObject({ type: "result", content: "The answer is 4." });
  });

  it("synthesizes a tool id when the recording lacks one", () => {
    const msg = blockToAgentMessage({ type: "tool_use", tool: "x", input: {} }, 7);
    expect(msg).toMatchObject({ type: "tool_use", id: "replay-tu-7" });
  });

  it("maps Plan snapshots back to replayable AgentMessages", () => {
    const msg = blockToAgentMessage(
      {
        type: "plan_update",
        plan: {
          explanation: "Working through the trace",
          steps: [
            { id: "inspect", text: "Inspect", status: "completed" },
            {
              text: "Implement",
              activeText: "Implementing",
              status: "in_progress",
            },
          ],
        },
      },
      8,
    );

    expect(msg).toEqual({
      type: "plan_update",
      plan: {
        explanation: "Working through the trace",
        steps: [
          { id: "inspect", text: "Inspect", status: "completed" },
          { text: "Implement", activeText: "Implementing", status: "in_progress" },
        ],
      },
    });
  });

  it("flattens subagent lifecycle blocks into a replayable tool pair", () => {
    const start = blockToAgentMessage(
      {
        type: "subagent_start",
        toolUseId: "subagent-1",
        agentName: "researcher",
        input: { task: "Investigate" },
        sessionId: "recorded-child-session",
        turnId: "recorded-child-turn",
        startedAt: "2026-01-01T00:00:00Z",
      },
      9,
    );
    const result = blockToAgentMessage(
      {
        type: "subagent_result",
        toolUseId: "subagent-1",
        agentName: "researcher",
        sessionId: "recorded-child-session",
        turnId: "recorded-child-turn",
        status: "completed",
        output: { result: "Done" },
        endedAt: "2026-01-01T00:00:01Z",
      },
      10,
    );

    expect(start).toEqual({
      type: "tool_use",
      id: "subagent-1",
      tool: "researcher",
      input: { task: "Investigate" },
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(result).toEqual({
      type: "tool_result",
      toolUseId: "subagent-1",
      tool: "researcher",
      output: { result: "Done" },
      endedAt: "2026-01-01T00:00:01Z",
    });
  });

  it("preserves failed subagent outcomes in the flattened result", () => {
    const result = blockToAgentMessage(
      {
        type: "subagent_result",
        toolUseId: "subagent-2",
        agentName: "researcher",
        sessionId: "recorded-child-session",
        turnId: "recorded-child-turn",
        status: "failed",
        error: { message: "Child failed", code: "child_error" },
      },
      11,
    );

    expect(result).toEqual({
      type: "tool_result",
      toolUseId: "subagent-2",
      tool: "researcher",
      output: {
        status: "failed",
        error: { message: "Child failed", code: "child_error" },
      },
    });
  });

  it("drops malformed Plan snapshots", () => {
    expect(
      blockToAgentMessage(
        {
          type: "plan_update",
          plan: { steps: [{ text: "Inspect", status: "unknown" }] },
        },
        9,
      ),
    ).toBeNull();
  });
});

describe("isTerminalBlock", () => {
  it("is true only for result/error", () => {
    expect(isTerminalBlock({ type: "result", content: "" })).toBe(true);
    expect(isTerminalBlock({ type: "error", error: "x" })).toBe(true);
    expect(isTerminalBlock({ type: "text", content: "" })).toBe(false);
  });
});
