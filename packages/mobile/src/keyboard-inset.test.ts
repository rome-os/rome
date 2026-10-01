import { describe, expect, it } from "@rstest/core";
import { keyboardOverlap } from "./keyboard-inset.js";

describe("keyboardOverlap", () => {
  it("is the part of a full-screen view below the keyboard's top edge", () => {
    expect(keyboardOverlap({ y: 0, height: 892 }, 548)).toBe(344);
  });

  it("is zero when the window already shrank to end at the keyboard", () => {
    expect(keyboardOverlap({ y: 0, height: 548 }, 548)).toBe(0);
  });

  it("never goes negative when the keyboard ends above the view", () => {
    expect(keyboardOverlap({ y: 0, height: 500 }, 548)).toBe(0);
  });

  it("rounds a fractional dp edge to a whole dp", () => {
    expect(keyboardOverlap({ y: 24.3, height: 867.4 }, 547.9)).toBe(344);
  });
});
