import { describe, expect, it } from "@rstest/core";
import { extractFilePathsFromText, isProjectPath } from "./extract-file-paths";

describe("extractFilePathsFromText", () => {
  it("returns empty for non-text events", () => {
    expect(extractFilePathsFromText({ type: "tool_use" })).toEqual([]);
    expect(extractFilePathsFromText({ type: "thinking", content: "x" })).toEqual([]);
  });

  it("returns empty when content is missing or empty", () => {
    expect(extractFilePathsFromText({ type: "text" })).toEqual([]);
    expect(extractFilePathsFromText({ type: "text", content: "" })).toEqual([]);
  });

  it("extracts a projects link with backticks in the label", () => {
    const content =
      "已完成。\n- [`00-overall-effect.png`](</projects/default/screenshots/icon-merch-20260528/00-overall-effect.png>) — 整体效果合成图";
    expect(extractFilePathsFromText({ type: "text", content })).toEqual([
      "/projects/default/screenshots/icon-merch-20260528/00-overall-effect.png",
    ]);
  });

  it("extracts multiple projects links in order and deduplicates", () => {
    const content = [
      "Created:",
      "- [a.png](</projects/default/a.png>)",
      "- [b.png](</projects/default/b.png>)",
      "- [a.png again](</projects/default/a.png>)",
    ].join("\n");
    expect(extractFilePathsFromText({ type: "text", content })).toEqual([
      "/projects/default/a.png",
      "/projects/default/b.png",
    ]);
  });

  it("ignores markdown links that are not rooted at /projects/", () => {
    const content = [
      "[external](https://example.com)",
      "[bare](/etc/passwd)",
      "[no-brackets](/projects/default/skip.png)",
      "[ok](</projects/default/keep.png>)",
    ].join("\n");
    expect(extractFilePathsFromText({ type: "text", content })).toEqual([
      "/projects/default/keep.png",
    ]);
  });

  it("returns empty when there are no projects links", () => {
    const content = "just text, no links";
    expect(extractFilePathsFromText({ type: "text", content })).toEqual([]);
  });
});

describe("isProjectPath", () => {
  it("accepts relative paths (resolved against the active project root)", () => {
    expect(isProjectPath("screenshots/icon-merch-20260528/00-overall-effect.png")).toBe(true);
    expect(isProjectPath("memory/IDENTITY.md")).toBe(true);
    expect(isProjectPath(".")).toBe(true);
  });

  it("accepts absolute paths that live under a /projects/ segment", () => {
    expect(isProjectPath("/Users/ray/.rome/default/projects/default/screenshots/Icon.jpg")).toBe(
      true,
    );
    expect(isProjectPath("/projects/default/foo.md")).toBe(true);
  });

  it("rejects absolute paths outside any /projects/ tree", () => {
    expect(isProjectPath("/etc/passwd")).toBe(false);
    expect(isProjectPath("/Users/ray/.codex/generated_images/abc.png")).toBe(false);
    expect(isProjectPath("/tmp/foo.txt")).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(isProjectPath("")).toBe(false);
  });
});
