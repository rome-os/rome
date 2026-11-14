import { describe, expect, it } from "@rstest/core";
import type { ChatMetrics } from "./metrics.js";
import { METRICS, type ScenarioResult, totalOf } from "./report.js";

const scenario = (
  owner: number,
  concierge: number,
  turns: number,
  promptTotal: number,
): ScenarioResult => ({
  id: `s${owner}-${turns}`,
  chatId: "c",
  seconds: 0,
  tasks: [],
  checks: { nothingDropped: true, notes: [] },
  metrics: {
    ownerMessages: owner,
    conciergeMessages: concierge,
    perOwnerMessage: concierge / owner,
    turns,
    inputTokens: { total: promptTotal, mean: promptTotal / turns },
    cacheReadTokens: { total: 0, mean: 0 },
    outputTokens: { total: 0, mean: 0 },
  } as unknown as ChatMetrics,
});

const metric = (name: string) => {
  const found = METRICS.find((m) => m.name === name);
  if (!found) throw new Error(name);
  return found;
};

describe("totalOf", () => {
  // One owner message answered with four, beside three answered with one each.
  const scenarios = [scenario(1, 4, 1, 100), scenario(3, 3, 9, 900)];

  it("rates per owner message from the summed messages, not a mean of rates", () => {
    // 7 / 4, where a mean of the rates (4 and 1) would read 2.5.
    expect(totalOf(metric("Per owner msg"), scenarios)).toBe(1.75);
  });

  it("rates tokens per turn from the summed tokens and turns", () => {
    // 1000 / 10, where a mean of the means (100 and 100) agrees only by chance.
    expect(
      totalOf(metric("Prompt tok/turn"), [scenario(1, 1, 1, 500), scenario(1, 1, 9, 900)]),
    ).toBe(140);
  });

  it("sums counts", () => {
    expect(totalOf(metric("Concierge msgs"), scenarios)).toBe(7);
  });
});
