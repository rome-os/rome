import { describe, expect, it } from "@rstest/core";
import { escapeMarkdownText } from "./markdown-text";

describe("escapeMarkdownText", () => {
  it("escapes Markdown syntax in filenames", () => {
    expect(escapeMarkdownText("[invoice](javascript:alert(1)).md")).toBe(
      "\\[invoice\\]\\(javascript:alert\\(1\\)\\)\\.md",
    );
  });

  it("keeps filenames from creating additional Markdown lines", () => {
    expect(escapeMarkdownText("first.md\n- injected.md")).toBe("first\\.md \\- injected\\.md");
  });
});
