import { describe, expect, it } from "@rstest/core";
import { isLinkCodeMessage } from "./guardian-link-code.js";

describe("isLinkCodeMessage", () => {
  it("reads a code-shaped message, in any case and with surrounding space", () => {
    expect(isLinkCodeMessage("ROME-ABCD2345")).toBe(true);
    expect(isLinkCodeMessage("  rome-abcd2345 ")).toBe(true);
  });

  it("reads anything else as an ordinary message", () => {
    expect(isLinkCodeMessage("ROME-ABC")).toBe(false);
    expect(isLinkCodeMessage("my code is ROME-ABCD2345")).toBe(false);
    expect(isLinkCodeMessage(undefined)).toBe(false);
  });
});
