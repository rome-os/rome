import { describe, expect, it } from "@rstest/core";
import { ConciergeTurnTiming } from "./turn-timing.js";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, at: (ms: number) => void (now = start + ms) };
}

const accounting = (over: Partial<{ numTurns: number; used: number }> = {}) => ({
  provider: "anthropic",
  model: "claude-opus-5-5",
  numTurns: over.numTurns ?? 2,
  context: { usedTokens: over.used ?? 31_000 },
  usage: { inputTokens: 10, outputTokens: 200, cacheReadTokens: 30_000, cacheWriteTokens: 900 },
});

describe("ConciergeTurnTiming", () => {
  it("times the start, the first sign, the first say and the end from the send", () => {
    const c = clock();
    const timing = new ConciergeTurnTiming(
      { chatId: "c", turnId: "t", trigger: "guardian", startedAtMs: 1_000, effort: "low", session: "cold" },
      "core:concierge",
      c.now,
    );
    c.at(1_500);
    timing.event({ type: "turn_start" });
    c.at(4_000);
    timing.event({ type: "tool_use", tool: "mcp__rome__WebSearch" });
    c.at(4_600);
    timing.working();
    timing.event({ type: "tool_use", tool: "mcp__rome-concierge__say" });
    c.at(9_000);
    timing.said();
    c.at(9_500);
    timing.said();
    timing.event({ type: "result", accounting: accounting() });
    c.at(10_000);

    expect(timing.finish()).toMatchObject({
      trigger: "guardian",
      model: "claude-opus-5-5",
      effort: "low",
      session: "cold",
      startMs: 1_500,
      workingMs: 4_600,
      reactedMs: null,
      firstSayMs: 9_000,
      ackMs: 4_600,
      durationMs: 10_000,
      modelCalls: 2,
      toolCalls: 2,
      tools: { websearch: 1, say: 1 },
      contextTokens: 31_000,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 900,
      outputTokens: 200,
      failed: false,
    });
  });

  it("takes a reaction or a say as the first sign when nothing showed working", () => {
    const c = clock();
    const timing = new ConciergeTurnTiming(
      { chatId: "c", turnId: "t", trigger: "guardian", startedAtMs: 1_000 },
      "core:concierge",
      c.now,
    );
    c.at(2_000);
    timing.reacted();
    c.at(3_000);
    expect(timing.finish()).toMatchObject({ ackMs: 2_000, firstSayMs: null, workingMs: null });
  });

  it("leaves out a subagent's events and adds up several model runs", () => {
    const c = clock();
    const timing = new ConciergeTurnTiming(
      { chatId: "c", turnId: "backend:x", trigger: "system", startedAtMs: 1_000 },
      "core:concierge",
      c.now,
    );
    timing.event({ type: "tool_use", tool: "Read", agent: "assistant:explore" });
    timing.event({ type: "result", accounting: accounting({ numTurns: 5 }), agent: "assistant:explore" });
    timing.event({ type: "result", accounting: accounting({ numTurns: 1, used: 40_000 }) });
    timing.event({ type: "error", accounting: accounting({ numTurns: 1, used: 41_000 }) });
    const timed = timing.finish("turn-own");
    expect(timed).toMatchObject({
      turnId: "turn-own",
      toolCalls: 0,
      modelCalls: 2,
      contextTokens: 41_000,
      outputTokens: 400,
      failed: true,
    });
  });

  it("finishes once", () => {
    const timing = new ConciergeTurnTiming(
      { chatId: "c", turnId: "t", trigger: "guardian", startedAtMs: 0 },
      "core:concierge",
      () => 5,
    );
    expect(timing.finish()).not.toBeNull();
    expect(timing.finish()).toBeNull();
  });
});
