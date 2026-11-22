import { describe, expect, it } from "@rstest/core";
import { RunningCost } from "./running-cost.js";

describe("RunningCost", () => {
  it("gives each result of a new thread what it added to the running total", () => {
    const cost = new RunningCost(true);
    expect(cost.next(0.5)).toBeCloseTo(0.5);
    expect(cost.next(0.75)).toBeCloseTo(0.25);
    expect(cost.next(0.75)).toBeCloseTo(0);
  });

  it("reports no cost for a resumed thread's first result, which includes earlier turns", () => {
    const cost = new RunningCost(false);
    expect(cost.next(7)).toBeUndefined();
    expect(cost.next(7.2)).toBeCloseTo(0.2);
  });

  it("starts over when the total drops, as after /clear", () => {
    const cost = new RunningCost(true);
    cost.next(3);
    expect(cost.next(0.1)).toBeCloseTo(0.1);
    expect(cost.next(0.4)).toBeCloseTo(0.3);
  });

  it("prices a result with no total from its tokens, and the next one too", () => {
    const cost = new RunningCost(true);
    cost.next(0.5);
    expect(cost.next(undefined)).toBeUndefined();
    // The total now includes the turn priced from its tokens.
    expect(cost.next(1)).toBeUndefined();
    expect(cost.next(1.5)).toBeCloseTo(0.5);
  });

  it("starts a resumed thread from its first total that isn't a zeroed placeholder", () => {
    const cost = new RunningCost(false);
    expect(cost.next(0)).toBeUndefined();
    expect(cost.next(42)).toBeUndefined();
    expect(cost.next(42.5)).toBeCloseTo(0.5);
  });

  it("does not take a zeroed result partway through as a restart", () => {
    const cost = new RunningCost(true);
    cost.next(2);
    expect(cost.next(0)).toBeUndefined();
    expect(cost.next(2.5)).toBeUndefined();
    expect(cost.next(3)).toBeCloseTo(0.5);
  });
});
