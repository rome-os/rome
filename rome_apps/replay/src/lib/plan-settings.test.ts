import { describe, expect, it } from "@rstest/core";
import {
  clampSpeed,
  clampTurnBudgetMs,
  DEFAULT_SPEED,
  DEFAULT_TURN_BUDGET_MS,
  SPEED_MAX,
  SPEED_MIN,
  TURN_BUDGET_MAX_MS,
  TURN_BUDGET_MIN_MS,
} from "./plan-settings.js";

describe("clampSpeed", () => {
  it("passes in-range values through unchanged", () => {
    expect(clampSpeed(0.5)).toBe(0.5);
    expect(clampSpeed(1)).toBe(1);
    expect(clampSpeed(2.5)).toBe(2.5);
    expect(clampSpeed(10)).toBe(10);
  });

  it("clamps out-of-range values to the bounds", () => {
    expect(clampSpeed(0.1)).toBe(SPEED_MIN);
    expect(clampSpeed(0)).toBe(SPEED_MIN);
    expect(clampSpeed(-3)).toBe(SPEED_MIN);
    expect(clampSpeed(100)).toBe(SPEED_MAX);
  });

  it("falls back to the default for non-finite values", () => {
    expect(clampSpeed(Number.NaN)).toBe(DEFAULT_SPEED);
    expect(clampSpeed(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPEED);
    expect(clampSpeed(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_SPEED);
  });
});

describe("clampTurnBudgetMs", () => {
  it("passes in-range values through, rounded to whole ms", () => {
    expect(clampTurnBudgetMs(30_000)).toBe(30_000);
    expect(clampTurnBudgetMs(15_000.7)).toBe(15_001);
  });

  it("clamps out-of-range values to the bounds", () => {
    expect(clampTurnBudgetMs(0)).toBe(TURN_BUDGET_MIN_MS);
    expect(clampTurnBudgetMs(-1)).toBe(TURN_BUDGET_MIN_MS);
    expect(clampTurnBudgetMs(600_000)).toBe(TURN_BUDGET_MAX_MS);
  });

  it("falls back to the default for non-finite values", () => {
    expect(clampTurnBudgetMs(Number.NaN)).toBe(DEFAULT_TURN_BUDGET_MS);
    expect(clampTurnBudgetMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TURN_BUDGET_MS);
  });
});
