import { describe, expect, it } from "@rstest/core";
import {
  buildProjectUsageChartTotals,
  buildProjectUsageTokenBreakdown,
} from "./project-usage-totals";

describe("project usage totals", () => {
  it("counts cache writes as input tokens and cache reads as cached tokens", () => {
    expect(
      buildProjectUsageTokenBreakdown({
        cacheReadTokens: 7,
        cacheWriteTokens: 5,
        inputTokens: 11,
        outputTokens: 13,
      }),
    ).toEqual({
      cached: 7,
      input: 16,
      output: 13,
      total: 36,
    });
  });

  it("aggregates dashboard usage with cache writes included in input", () => {
    const totals = buildProjectUsageChartTotals([
      {
        cacheReadTokens: 7,
        cacheWriteTokens: 5,
        costUsd: 0.1,
        date: "2026-05-15",
        inputTokens: 11,
        outputTokens: 13,
      },
      {
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        costUsd: 0.2,
        date: "2026-05-16",
        inputTokens: 17,
        outputTokens: 19,
      },
    ]);

    expect(totals).toMatchObject({
      cacheRead: 9,
      cacheWrite: 8,
      cached: 9,
      input: 36,
      output: 32,
      total: 77,
    });
    expect(totals.cost).toBeCloseTo(0.3);
  });
});
