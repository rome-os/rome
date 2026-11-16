import { describe, expect, it } from "@rstest/core";
import { nextReveal, REVEAL_CHARS_PER_SECOND } from "./VoiceInputSpokenText";

describe("revealing spoken text", () => {
  it("shows as many more characters as the budget allows", () => {
    expect(nextReveal("buy", "buy milk", 2)).toBe("buy m");
  });

  it("stops at the end of the text heard so far", () => {
    expect(nextReveal("buy mi", "buy milk", 5)).toBe("buy milk");
  });

  it("takes back a corrected word and reveals the correction from there", () => {
    expect(nextReveal("buy silk", "buy milk", 1)).toBe("buy m");
  });

  it("never falls more than a second behind", () => {
    const goal = "x".repeat(REVEAL_CHARS_PER_SECOND + 30);
    expect(nextReveal("", goal, 1)).toHaveLength(30);
  });
});
