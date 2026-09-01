import { describe, expect, it } from "@rstest/core";
import { advanceReveal, splitGraphemes } from "./use-smooth-text";

describe("advanceReveal pacing", () => {
  it("reveals at the base rate when the backlog is small", () => {
    // 10-char backlog → base rate (120 cps) wins over backlog * 4 = 40.
    const next = advanceReveal(0, 0, 10, 1 / 60);
    expect(next.shown).toBe(2); // 120 cps / 60 fps
  });

  it("scales the rate with a large backlog so the display catches up", () => {
    // 600-char backlog → 2400 cps beats the 120 cps base.
    const next = advanceReveal(0, 0, 600, 1 / 60);
    expect(next.shown).toBe(40); // 2400 / 60
  });

  it("never reveals past the target", () => {
    const next = advanceReveal(95, 0, 100, 1);
    expect(next.shown).toBe(100);
  });

  it("returns the target immediately when already caught up", () => {
    expect(advanceReveal(100, 0.5, 100, 1)).toEqual({ shown: 100, carry: 0 });
  });

  it("carries fractional budget across frames instead of dropping it", () => {
    // 120 cps at 240 fps = 0.5 chars/frame: every other frame reveals one.
    const a = advanceReveal(0, 0, 10, 1 / 240);
    expect(a.shown).toBe(0);
    const b = advanceReveal(a.shown, a.carry, 10, 1 / 240);
    expect(b.shown).toBe(1);
  });

  it("caps the carried budget so a stall cannot bank a burst", () => {
    const next = advanceReveal(0, 0, 2, 10);
    expect(next.shown).toBe(2);
    expect(next.carry).toBeLessThanOrEqual(1);
  });
});

describe("splitGraphemes", () => {
  it("keeps surrogate-pair emoji whole", () => {
    expect(splitGraphemes("a👍b")).toEqual(["a", "👍", "b"]);
  });

  it("keeps ZWJ sequences and flags as single clusters", () => {
    // Family emoji (ZWJ sequence) and a regional-indicator flag — slicing
    // these by UTF-16 units renders broken glyphs mid-reveal.
    expect(splitGraphemes("👨‍👩‍👧🇮🇹")).toEqual(["👨‍👩‍👧", "🇮🇹"]);
  });

  it("returns an empty array for the empty string", () => {
    expect(splitGraphemes("")).toEqual([]);
  });

  it("round-trips: joining the segments reproduces the input", () => {
    const text = "Hello 世界 👩🏽‍🚀 café";
    expect(splitGraphemes(text).join("")).toBe(text);
  });
});
