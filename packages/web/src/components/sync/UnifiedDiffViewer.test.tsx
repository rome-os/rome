// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { parseUnifiedDiff, UnifiedDiffViewer } from "./UnifiedDiffViewer";

afterEach(cleanup);

describe("parseUnifiedDiff", () => {
  it("tracks old and new line numbers across a hunk", () => {
    const lines = parseUnifiedDiff(
      ["@@ -10,3 +10,3 @@", " context", "-removed", "+added", " trailing"].join("\n"),
    );

    expect(lines).toEqual([
      { kind: "hunk", content: "@@ -10,3 +10,3 @@" },
      { kind: "context", content: " context", oldLine: 10, newLine: 10 },
      { kind: "removed", content: "-removed", oldLine: 11 },
      { kind: "added", content: "+added", newLine: 11 },
      { kind: "context", content: " trailing", oldLine: 12, newLine: 12 },
    ]);
  });

  it("parses added and removed content that shares file-header prefixes", () => {
    const lines = parseUnifiedDiff(
      ["@@ -20,2 +20,2 @@", "---removed", "+++added", " context"].join("\n"),
    );

    expect(lines).toEqual([
      { kind: "hunk", content: "@@ -20,2 +20,2 @@" },
      { kind: "removed", content: "---removed", oldLine: 20 },
      { kind: "added", content: "+++added", newLine: 20 },
      { kind: "context", content: " context", oldLine: 21, newLine: 21 },
    ]);
  });
});

describe("UnifiedDiffViewer", () => {
  it("renders metadata-only patches", () => {
    render(
      <UnifiedDiffViewer
        diff={{
          path: "new-name.ts",
          patch: [
            "diff --git a/old-name.ts b/new-name.ts",
            "similarity index 100%",
            "rename from old-name.ts",
            "rename to new-name.ts",
          ].join("\n"),
        }}
      />,
    );

    expect(screen.getByText("File metadata changed")).toBeTruthy();
    expect(screen.getByText("rename from old-name.ts")).toBeTruthy();
    expect(screen.getByText("rename to new-name.ts")).toBeTruthy();
    expect(screen.queryByText("No textual differences to display")).toBeNull();
  });
});
