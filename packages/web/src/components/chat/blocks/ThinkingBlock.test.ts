import { describe, expect, it } from "@rstest/core";
import { getThinkingBlockPreview, stripPreviewMarkdown } from "./ThinkingBlock";

describe("getThinkingBlockPreview", () => {
  it("uses the first line of a thinking block", () => {
    expect(
      getThinkingBlockPreview("Inspecting the trace UI\nThen checking tests", "Thinking..."),
    ).toBe("Inspecting the trace UI");
  });

  it("trims the first line", () => {
    expect(getThinkingBlockPreview("  Mapping current behavior  \nNext", "Thinking...")).toBe(
      "Mapping current behavior",
    );
  });

  it("falls back when the first line is empty", () => {
    expect(getThinkingBlockPreview("\nSecond line", "Thinking...")).toBe("Thinking...");
  });

  it("strips inline markdown emphasis from the preview", () => {
    // Codex-style headings should not surface their literal `**` markers in
    // the single-line preview row.
    expect(getThinkingBlockPreview("**Considering the user's request**", "Thinking...")).toBe(
      "Considering the user's request",
    );
  });
});

describe("stripPreviewMarkdown", () => {
  it("strips bold, italic, code and strikethrough markers", () => {
    expect(stripPreviewMarkdown("**bold** and *em* and _emu_ and `code` and ~~gone~~")).toBe(
      "bold and em and emu and code and gone",
    );
  });

  it("leaves plain text untouched", () => {
    expect(stripPreviewMarkdown("just a sentence.")).toBe("just a sentence.");
  });
});
