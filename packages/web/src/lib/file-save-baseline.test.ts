import { describe, expect, it } from "@rstest/core";
import { getSuccessfulFileSaveBaselineUpdate } from "./file-save-baseline";

describe("getSuccessfulFileSaveBaselineUpdate", () => {
  it("applies successful disk and commit saves for the selected file", () => {
    const update = getSuccessfulFileSaveBaselineUpdate({
      commit: true,
      savedPath: "memory/notes.md",
      selectedPath: "memory/notes.md",
      sequence: 1,
      sequences: { commit: 0, disk: 0 },
    });

    expect(update).toEqual({
      applyCommit: true,
      applyDisk: true,
      sequences: { commit: 1, disk: 1 },
    });
  });

  it("records non-commit disk saves without advancing the commit baseline", () => {
    const update = getSuccessfulFileSaveBaselineUpdate({
      commit: false,
      savedPath: "memory/notes.md",
      selectedPath: "memory/notes.md",
      sequence: 2,
      sequences: { commit: 1, disk: 1 },
    });

    expect(update).toEqual({
      applyCommit: false,
      applyDisk: true,
      sequences: { commit: 1, disk: 2 },
    });
  });

  it("does not roll disk baseline back when an older save resolves late", () => {
    const update = getSuccessfulFileSaveBaselineUpdate({
      commit: true,
      savedPath: "memory/notes.md",
      selectedPath: "memory/notes.md",
      sequence: 2,
      sequences: { commit: 1, disk: 3 },
    });

    expect(update).toEqual({
      applyCommit: true,
      applyDisk: false,
      sequences: { commit: 2, disk: 3 },
    });
  });

  it("records ordering without applying baselines for files that are no longer selected", () => {
    const update = getSuccessfulFileSaveBaselineUpdate({
      commit: true,
      savedPath: "memory/notes.md",
      selectedPath: "memory/other.md",
      sequence: 2,
      sequences: { commit: 1, disk: 1 },
    });

    expect(update).toEqual({
      applyCommit: false,
      applyDisk: false,
      sequences: { commit: 2, disk: 2 },
    });
  });
});
