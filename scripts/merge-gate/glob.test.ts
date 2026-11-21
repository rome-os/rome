import { describe, expect, it } from "@rstest/core";
import { matchesGlob } from "./glob.js";

describe("matchesGlob", () => {
  it.each([
    ["packages/core/src/participation/**", "packages/core/src/participation/addressing.ts", true],
    ["packages/core/src/participation/**", "packages/core/src/participation/deep/a/b.ts", true],
    ["packages/core/src/participation/**", "packages/core/src/participationx/a.ts", false],
    ["packages/core/src/participation/**", "packages/core/src/a.ts", false],
    ["packages/*/src/x.ts", "packages/core/src/x.ts", true],
    ["packages/*/src/x.ts", "packages/core/deep/src/x.ts", false],
    ["packages/**/x.ts", "packages/x.ts", true],
    ["packages/**/x.ts", "packages/a/b/x.ts", true],
    ["**/x.ts", "x.ts", true],
    ["**/x.ts", "a/b/x.ts", true],
    ["docs/*.md", "docs/a.md", true],
    ["docs/*.md", "docs/sub/a.md", false],
    ["docs/*.md", "docs/amd", false],
    ["scripts/check-*", "scripts/check-prose.mjs", true],
    ["file?.ts", "file1.ts", true],
    ["file?.ts", "file/.ts", false],
    ["a+b(c).ts", "a+b(c).ts", true],
  ])("%s against %s is %s", (glob, path, want) => {
    expect(matchesGlob(glob, path)).toBe(want);
  });
});
