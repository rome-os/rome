import { describe, expect, it } from "@rstest/core";
import { buildAgentAccounting, calculateImpliedCostUsd } from "./provider-accounting.js";

describe("provider-accounting", () => {
  it("calculates Anthropic Fable 5 costs using cache read and 5-minute cache write rates", () => {
    const impliedCostUsd = calculateImpliedCostUsd("anthropic", "claude-fable-5[1m]", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });

    expect(impliedCostUsd).toBeCloseTo(73.5);
  });

  it("uses Anthropic Fable 5 1-hour cache write pricing when reported by usage metadata", () => {
    const accounting = buildAgentAccounting({
      provider: "anthropic",
      model: "claude-fable-5[1m]",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 1_000_000,
      },
      rawUsage: {
        cache_write_ttl_seconds: 3600,
      },
    });

    expect(accounting.costUsd).toBeCloseTo(20);
  });

  it("calculates Anthropic Sonnet 5 costs using cache read and 5-minute cache write rates", () => {
    const impliedCostUsd = calculateImpliedCostUsd("anthropic", "claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });

    expect(impliedCostUsd).toBeCloseTo(22.05);
  });

  it("matches model aliases with dated suffixes", () => {
    const accounting = buildAgentAccounting({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });

    expect(accounting.costUsd).toBeCloseTo(6);
  });

  it("supports future provider-specific cache write durations via raw usage metadata", () => {
    const accounting = buildAgentAccounting({
      provider: "anthropic",
      model: "claude-opus-4-6[1m]",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 1_000_000,
      },
      rawUsage: {
        cache_write_ttl_seconds: 3600,
      },
    });

    expect(accounting.costUsd).toBeCloseTo(10);
  });

  it("accounts for the alternate Opus 4-8 1m model id", () => {
    const impliedCostUsd = calculateImpliedCostUsd("anthropic", "claude-opus-4-8[1m]", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(impliedCostUsd).toBeCloseTo(30);
  });

  it("accounts for the Opus 5 1m model id at Opus rates", () => {
    const impliedCostUsd = calculateImpliedCostUsd("anthropic", "claude-opus-5[1m]", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(impliedCostUsd).toBeCloseTo(30);
  });

  it("calculates Meta Muse Spark costs using provider-supplied rates", () => {
    const impliedCostUsd = calculateImpliedCostUsd("anthropic", "muse-spark-1.1", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });

    expect(impliedCostUsd).toBeCloseTo(6.9);
  });

  it("calculates OpenAI GPT-5.4 and GPT-5.5 costs using official standard rates", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    };

    expect(calculateImpliedCostUsd("openai", "gpt-5.5:high", usage)).toBeCloseTo(35.5);
    expect(calculateImpliedCostUsd("openai", "gpt-5.5:medium", usage)).toBeCloseTo(35.5);
    expect(calculateImpliedCostUsd("openai", "gpt-5.5:low", usage)).toBeCloseTo(35.5);
    expect(calculateImpliedCostUsd("openai", "gpt-5.4:high", usage)).toBeCloseTo(17.75);
    expect(calculateImpliedCostUsd("openai", "gpt-5.4-mini:medium", usage)).toBeCloseTo(5.325);
    expect(calculateImpliedCostUsd("openai", "gpt-5.4-2026-03-05:medium", usage)).toBeCloseTo(
      17.75,
    );
    expect(calculateImpliedCostUsd("openai", "gpt-5.4-mini-2026-03-17:medium", usage)).toBeCloseTo(
      5.325,
    );
  });

  it("calculates GPT-5.6 Sol, Terra, and Luna costs with cache pricing", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };

    expect(calculateImpliedCostUsd("openai", "gpt-5.6-sol", usage)).toBeCloseTo(41.75);
    expect(calculateImpliedCostUsd("openai", "gpt-5.6", usage)).toBeCloseTo(41.75);
    expect(calculateImpliedCostUsd("openai", "gpt-5.6-terra", usage)).toBeCloseTo(20.875);
    expect(calculateImpliedCostUsd("openai", "gpt-5.6-luna", usage)).toBeCloseTo(8.35);
  });

  it("applies GPT-5.6 long-context input and output multipliers", () => {
    const impliedCostUsd = calculateImpliedCostUsd(
      "openai",
      "gpt-5.6-sol",
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
      { input_tokens: 272_001 },
    );

    expect(impliedCostUsd).toBeCloseTo(68.5);
  });

  it("preserves provider-reported live context usage separately from token accounting", () => {
    const accounting = buildAgentAccounting({
      provider: "anthropic",
      model: "claude-opus-4-6[1m]",
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 0,
      },
      context: {
        usedTokens: 10_000,
        windowTokens: 1_000_000,
        remainingTokens: 990_000,
      },
    });

    expect(accounting.context).toEqual({
      usedTokens: 10_000,
      windowTokens: 1_000_000,
      remainingTokens: 990_000,
    });
  });
});
