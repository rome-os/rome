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

  it("keeps its place across a result with no total", () => {
    const cost = new RunningCost(true);
    cost.next(1);
    expect(cost.next(undefined)).toBeUndefined();
    expect(cost.next(1.5)).toBeCloseTo(0.5);
  });
});
