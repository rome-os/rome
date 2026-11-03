import { describe, expect, it } from "@rstest/core";
import {
  buildProjectProviderUsageRows,
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

  it("folds providers into Claude, Codex, and Other rows and drops empty ones", () => {
    const usage = (provider: string, inputTokens: number, costUsd: number) => ({
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd,
      inputTokens,
      outputTokens: 3,
      provider,
    });

    expect(
      buildProjectProviderUsageRows([
        usage("openai", 10, 0.5),
        usage("google", 4, 0.1),
        usage("anthropic", 20, 1),
        usage("unknown", 6, 0.2),
        { ...usage("anthropic", 0, 0), cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      ]),
    ).toEqual([
      { cached: 2, cost: 1, input: 21, key: "claude", output: 3, total: 26 },
      { cached: 2, cost: 0.5, input: 11, key: "codex", output: 3, total: 16 },
      { cached: 4, cost: expect.closeTo(0.3), input: 12, key: "other", output: 6, total: 22 },
    ]);
    expect(
      buildProjectProviderUsageRows(
        [usage("openai", 0, 0)].map((entry) => ({
          ...entry,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
        })),
      ),
    ).toEqual([]);
  });
});
