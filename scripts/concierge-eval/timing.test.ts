import { describe, expect, it } from "@rstest/core";
import { parseVerdict } from "./judge.js";
import { quantile, spread, timedTurns } from "./timing.js";

const line = (data: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: "2026-11-16T20:00:00.000Z",
    level: "info",
    component: "concierge-turn-timing",
    message: "concierge.turn.timed",
    data,
  });

describe("timedTurns", () => {
  it("reads the timed turns out of the container's log, leaving other lines", () => {
    const logs = [
      "not json concierge.turn.timed",
      JSON.stringify({ message: "Rome started", data: {} }),
      line({ chatId: "c1", trigger: "guardian", firstSayMs: 2400, tools: '{"say":1}' }),
      line({ chatId: "c2", trigger: "system", firstSayMs: null, tools: "{}" }),
    ].join("\n");
    const turns = timedTurns(logs);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      chatId: "c1",
      firstSayMs: 2400,
      tools: { say: 1 },
      at: "2026-11-16T20:00:00.000Z",
    });
    expect(turns[1]?.firstSayMs).toBeNull();
  });
});

describe("quantile", () => {
  it("takes the nearest rank, so p95 of a few runs is their max", () => {
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([3, 1, 2], 0.95)).toBe(3);
    expect(quantile([], 0.5)).toBeNull();
    expect(spread([1000, null, 3000])).toEqual({ n: 2, p50: 1000, p95: 3000 });
  });
});

describe("parseVerdict", () => {
  it("reads the judge's JSON, even with words around it", () => {
    expect(parseVerdict('Here: {"score": 4, "why": "right, a bit long"}')).toEqual({
      score: 4,
      why: "right, a bit long",
    });
    expect(parseVerdict('{"score": 9, "why": "x"}')).toBeNull();
    expect(parseVerdict("no verdict")).toBeNull();
  });
});
