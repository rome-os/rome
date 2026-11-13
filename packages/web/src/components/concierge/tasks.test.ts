import { describe, expect, it } from "@rstest/core";
import type { ConciergeTaskDto, ConciergeTaskState } from "@rome/api-types/concierge";
import { applyTaskUpsert, formatTaskTime } from "./tasks";

const NOW = Date.UTC(2026, 9, 29, 12);
const DAY = 86_400_000;

let seq = 0;
function task(state: ConciergeTaskState, extra: Partial<ConciergeTaskDto> = {}): ConciergeTaskDto {
  seq += 1;
  return {
    id: `t${seq}`,
    title: `Task ${seq}`,
    state,
    summary: null,
    waitingOn: null,
    dueAt: null,
    rank: null,
    chat: null,
    sourceMessageId: null,
    createdAt: NOW - 10 * DAY + seq,
    updatedAt: NOW - 1000 * seq,
    completedAt: null,
    archivedAt: null,
    notSynced: false,
    conciergeChat: { id: "concierge", name: "Concierge", main: true },
    ...extra,
  };
}

describe("applyTaskUpsert", () => {
  it("adds a new row and replaces a known one", () => {
    const row = task("doing", { title: "A" });
    const added = applyTaskUpsert([], row);
    expect(added).toEqual([row]);
    const changed = { ...row, state: "done" as const, updatedAt: row.updatedAt + 1 };
    expect(applyTaskUpsert(added, changed)).toEqual([changed]);
  });

  it("removes a row the Concierge archived", () => {
    const row = task("done");
    expect(
      applyTaskUpsert([row], { ...row, archivedAt: NOW, updatedAt: row.updatedAt + 1 }),
    ).toEqual([]);
  });

  it("ignores an event older than the row it holds, but takes a mark change at the same time", () => {
    const row = task("doing");
    expect(applyTaskUpsert([row], { ...row, state: "next", updatedAt: row.updatedAt - 1 })).toEqual(
      [row],
    );
    const marked = { ...row, notSynced: true };
    expect(applyTaskUpsert([row], marked)).toEqual([marked]);
  });
});

describe("formatTaskTime", () => {
  it("reads a time in the reader's language", () => {
    expect(formatTaskTime(NOW - 5 * 60_000, NOW, "en")).toBe("5 min ago");
    expect(formatTaskTime(NOW - 3 * 3_600_000, NOW, "en")).toBe("3 hr ago");
    expect(formatTaskTime(NOW + DAY, NOW, "en")).toBe("tomorrow");
    // Short abbreviations come without their dots.
    expect(formatTaskTime(NOW + 25 * 60_000, NOW, "en")).toBe("in 25 min");
    expect(formatTaskTime(NOW - 10_000, NOW, "en")).toBe("now");
  });
});
