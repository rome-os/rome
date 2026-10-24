import { describe, expect, it } from "@rstest/core";
import { mayTearDownStack, pinnedSlug } from "./gc-stack-guard.js";

describe("mayTearDownStack", () => {
  const worktree = "/src/rome-worktrees/shared";

  it("keeps the stack this shell pins, even for a worktree of the same name", () => {
    expect(
      mayTearDownStack({
        slug: "shared",
        worktreePath: worktree,
        pinned: "shared",
        owner: worktree,
        ownerDirs: [worktree],
      }),
    ).toBe(false);
  });

  it("keeps a stack started from another checkout", () => {
    expect(
      mayTearDownStack({
        slug: "shared",
        worktreePath: worktree,
        pinned: null,
        owner: null,
        ownerDirs: ["/src/rome"],
      }),
    ).toBe(false);
  });

  it("tears down a stack the worktree started itself", () => {
    expect(
      mayTearDownStack({
        slug: "shared",
        worktreePath: worktree,
        pinned: null,
        owner: null,
        ownerDirs: [worktree],
      }),
    ).toBe(true);
  });

  it("keeps the stack when Docker cannot say who owns it", () => {
    expect(
      mayTearDownStack({
        slug: "shared",
        worktreePath: worktree,
        pinned: null,
        owner: null,
        ownerDirs: null,
      }),
    ).toBe(false);
  });

  it("keeps the stack when no container proves an owner", () => {
    expect(
      mayTearDownStack({
        slug: "shared",
        worktreePath: worktree,
        pinned: null,
        owner: null,
        ownerDirs: [],
      }),
    ).toBe(false);
  });
});

describe("mayTearDownStack with an owner file", () => {
  const worktree = "/src/rome-worktrees/shared";

  it("tears down a stack whose owner file names this worktree, with no containers left", () => {
    expect(
      mayTearDownStack({
        slug: "shared",
        worktreePath: worktree,
        pinned: null,
        owner: worktree,
        ownerDirs: [],
      }),
    ).toBe(true);
  });

  it("keeps a stack whose containers name another checkout, whatever the owner file says", () => {
    expect(
      mayTearDownStack({
        slug: "shared",
        worktreePath: worktree,
        pinned: null,
        owner: worktree,
        ownerDirs: ["/src/rome"],
      }),
    ).toBe(false);
  });

  it("keeps a stack whose owner file names another checkout", () => {
    expect(
      mayTearDownStack({
        slug: "shared",
        worktreePath: worktree,
        pinned: null,
        owner: "/src/rome",
        ownerDirs: [worktree],
      }),
    ).toBe(false);
  });
});

describe("mayTearDownStack with Docker unreachable", () => {
  it("keeps a stack even when its owner file names this worktree", () => {
    const worktree = "/src/rome-worktrees/shared";
    expect(
      mayTearDownStack({
        slug: "shared",
        worktreePath: worktree,
        pinned: null,
        owner: worktree,
        ownerDirs: null,
      }),
    ).toBe(false);
  });
});

describe("pinnedSlug", () => {
  it("applies the slug rule, and pins nothing when it is unset or sanitizes to empty", () => {
    expect(pinnedSlug({ ROME_DEV_SLUG: "Eric Dev/1" })).toBe("eric-dev-1");
    expect(pinnedSlug({})).toBeNull();
    expect(pinnedSlug({ ROME_DEV_SLUG: "!!!" })).toBeNull();
  });
});
