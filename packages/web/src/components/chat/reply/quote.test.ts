import { describe, expect, it } from "@rstest/core";
import { quoteLine } from "./reply-source";

describe("the line a quote shows", () => {
  it("is the first line of the quoted message with text, as plain reading text", () => {
    expect(quoteLine("Yes, €200 minimum.\n\n> Back room: €200\n> Main room: none")).toBe(
      "Yes, €200 minimum.",
    );
    expect(quoteLine("## Plan Kyoto\nthen the hotels")).toBe("Plan Kyoto");
    expect(quoteLine("\n\n**Booked** it")).toBe("Booked it");
  });

  it("skips the fence of a code block, and is empty for a message with no words", () => {
    expect(quoteLine("```py\nx = 1\n```")).toBe("x = 1");
    expect(quoteLine("   \n")).toBe("");
  });
});
