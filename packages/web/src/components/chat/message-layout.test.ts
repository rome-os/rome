import { describe, expect, it } from "@rstest/core";
import { messageLayout } from "./message-layout";

describe("messageLayout", () => {
  it("keeps a short answer in a bubble", () => {
    expect(messageLayout("Sunny, 24° high, light wind. No umbrella needed.")).toBe("bubble");
    expect(messageLayout("Done.\n\nI moved the brief to 07:00.")).toBe("bubble");
  });

  it("keeps a short list and inline formatting in a bubble", () => {
    expect(messageLayout("Two options:\n\n- **Warm**\n- `Plain`\n- Skip it")).toBe("bubble");
  });

  it("makes a document of text the agent sent as long, however short", () => {
    expect(messageLayout("Short.", "long")).toBe("document");
    expect(messageLayout("Short.", "bubble")).toBe("bubble");
  });

  it("makes a document of a heading", () => {
    expect(messageLayout("## Plan\n\nOne line.")).toBe("document");
    expect(messageLayout("#hashtag is not a heading")).toBe("bubble");
  });

  it("makes a document of a table", () => {
    expect(messageLayout("| Day | Plan |\n| --- | --- |\n| 1 | Kyoto |")).toBe("document");
    expect(messageLayout("|:--|--:|")).toBe("document");
    expect(messageLayout("A | B, not a table.")).toBe("bubble");
  });

  it("makes a document of a list of four items or more", () => {
    expect(messageLayout("- a\n- b\n- c\n- d")).toBe("document");
    expect(messageLayout("1. a\n2. b\n3. c\n4. d")).toBe("document");
  });

  it("makes a document of more than six lines", () => {
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `Line ${i}`);
    expect(messageLayout(lines(6).join("\n"))).toBe("bubble");
    expect(messageLayout(lines(7).join("\n"))).toBe("document");
    // Blank lines between paragraphs do not count.
    expect(messageLayout(lines(6).join("\n\n"))).toBe("bubble");
  });

  it("makes a document of more than 400 characters", () => {
    expect(messageLayout("a".repeat(400))).toBe("bubble");
    expect(messageLayout("a".repeat(401))).toBe("document");
  });

  it("reads no heading, table or list inside a code fence", () => {
    const fenced = "```md\n# not a heading\n| a | b |\n| - | - |\n```";
    expect(messageLayout(fenced)).toBe("bubble");
    // A shorter fence of the same kind does not close it.
    expect(messageLayout("````\n```\n# still code\n````")).toBe("bubble");
    expect(messageLayout("```\ncode\n```\n# Heading")).toBe("document");
  });
});
