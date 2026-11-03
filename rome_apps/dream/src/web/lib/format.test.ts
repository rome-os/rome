import { describe, expect, it } from "@rstest/core";
import type { RunListItem } from "../../lib/run-view";
import { outcomeLine } from "./format";

function review(outcome: Partial<RunListItem["outcome"]>): RunListItem {
  return {
    id: "r",
    kind: "skill_review",
    status: "completed",
    startedAt: "2026-10-06T00:00:00Z",
    finishedAt: "2026-10-06T00:01:00Z",
    windowHours: null,
    reviewedSession: null,
    outcome: { journal: false, memoryFiles: 0, skills: [], otherFiles: 0, ...outcome },
  };
}

describe("outcomeLine", () => {
  it("names saved and updated skills", () => {
    expect(outcomeLine(review({ skills: [{ name: "deploy", op: "write" }] }))).toBe("Saved deploy");
    expect(outcomeLine(review({ skills: [{ name: "deploy", op: "edit" }] }))).toBe(
      "Updated deploy",
    );
  });

  it("counts other files a review changed without saving a skill", () => {
    expect(outcomeLine(review({ otherFiles: 1 }))).toBe("1 other file");
  });

  it("says no changes only when nothing was recorded", () => {
    expect(outcomeLine(review({}))).toBe("No changes");
  });
});
