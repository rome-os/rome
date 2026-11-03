import { describe, expect, it } from "@rstest/core";
import { foldContext, lineDiff, splitFrontmatter, stripLeadingTitle } from "./diff";

describe("lineDiff", () => {
  it("shows an insertion under an anchor heading as context plus additions", () => {
    expect(lineDiff("## Preferences", "## Preferences\n- Short replies\n- No emoji")).toEqual([
      { type: "context", text: "## Preferences" },
      { type: "added", text: "- Short replies" },
      { type: "added", text: "- No emoji" },
    ]);
  });

  it("shows a replaced line between shared lines", () => {
    expect(lineDiff("a\nold\nz", "a\nnew\nz")).toEqual([
      { type: "context", text: "a" },
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
      { type: "context", text: "z" },
    ]);
  });

  it("treats an empty previous text as a pure addition", () => {
    expect(lineDiff("", "one")).toEqual([{ type: "added", text: "one" }]);
  });
});

describe("foldContext", () => {
  it("folds unchanged lines far from the change", () => {
    const lines = lineDiff("1\n2\n3\n4\n5\nold\n6\n7", "1\n2\n3\n4\n5\nnew\n6\n7");
    expect(foldContext(lines, 2)).toEqual([
      { type: "skip", count: 3 },
      { type: "context", text: "4" },
      { type: "context", text: "5" },
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
      { type: "context", text: "6" },
      { type: "context", text: "7" },
    ]);
  });
});

describe("splitFrontmatter", () => {
  it("returns the description and the body", () => {
    expect(
      splitFrontmatter('---\nname: deploy\ndescription: "Ship the app"\n---\n# Deploy\nSteps'),
    ).toEqual({ description: "Ship the app", body: "# Deploy\nSteps" });
  });

  it("leaves text without frontmatter alone", () => {
    expect(splitFrontmatter("# Deploy")).toEqual({ description: null, body: "# Deploy" });
  });
});

describe("stripLeadingTitle", () => {
  it("drops the first H1 only", () => {
    expect(stripLeadingTitle("# Journal — 2026-10-06\n\n## Summary\nText")).toBe(
      "## Summary\nText",
    );
    expect(stripLeadingTitle("## Summary\nText")).toBe("## Summary\nText");
  });
});
