import { describe, expect, it } from "@rstest/core";
import { startedElsewhere } from "./gc-stack-guard.js";

describe("startedElsewhere", () => {
  const worktree = "/src/rome-worktrees/shared";

  it("protects a stack another checkout started, such as one pinned by ROME_DEV_SLUG", () => {
    expect(startedElsewhere(["/src/rome"], worktree)).toBe(true);
    expect(startedElsewhere([worktree, "/src/rome"], worktree)).toBe(true);
  });

  it("protects every stack when Docker cannot be asked", () => {
    expect(startedElsewhere(null, worktree)).toBe(true);
  });

  it("lets gc remove a stack this worktree started, or one with no containers", () => {
    expect(startedElsewhere([worktree], worktree)).toBe(false);
    expect(startedElsewhere([], worktree)).toBe(false);
  });
});
