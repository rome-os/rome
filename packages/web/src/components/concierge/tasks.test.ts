import { describe, expect, it } from "@rstest/core";
import type { ConciergeTaskDto, ConciergeTaskState } from "@rome/api-types/concierge";
import {
  applyTaskUpsert,
  formatTaskTime,
  groupTasks,
  needsYouCount,
  pillState,
  taskTime,
} from "./tasks";

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
    createdAt: NOW - 10 * DAY + seq,
    updatedAt: NOW - 1000 * seq,
    completedAt: null,
    archivedAt: null,
    notSynced: false,
    ...extra,
  };
}

describe("groupTasks", () => {
  it("shows the five groups in order and leaves empty ones out", () => {
    const groups = groupTasks(
      [
        task("done", { completedAt: NOW - DAY }),
        task("watching"),
        task("next"),
        task("doing"),
        task("needs_user"),
      ],
      { now: NOW },
    );
    expect(groups.map((group) => group.key)).toEqual([
      "needsYou",
      "doing",
      "next",
      "watching",
      "done",
    ]);
    expect(groupTasks([task("doing")], { now: NOW }).map((group) => group.key)).toEqual(["doing"]);
    expect(groupTasks([], { now: NOW })).toEqual([]);
  });

  it("orders Up next by the Concierge's rank and Watching by due time, unranked last", () => {
    const groups = groupTasks(
      [
        task("next", { title: "unranked" }),
        task("next", { title: "second", rank: 2 }),
        task("next", { title: "first", rank: 1 }),
        task("watching", { title: "later", dueAt: NOW + 2 * DAY }),
        task("watching", { title: "undated" }),
        task("watching", { title: "soon", dueAt: NOW + DAY }),
      ],
      { now: NOW },
    );
    const titles = (key: string) =>
      groups.find((group) => group.key === key)?.tasks.map((item) => item.title);
    expect(titles("next")).toEqual(["first", "second", "unranked"]);
    expect(titles("watching")).toEqual(["soon", "later", "undated"]);
  });

  it("puts done and dropped rows together, newest completion first", () => {
    const [done] = groupTasks(
      [
        task("done", { title: "older", completedAt: NOW - 3 * DAY }),
        task("dropped", { title: "newer", completedAt: NOW - DAY }),
      ],
      { now: NOW },
    );
    expect(done.tasks.map((item) => item.title)).toEqual(["newer", "older"]);
  });

  it("shows finished rows of the last 7 days by completion and holds older ones behind show more", () => {
    const rows = [
      task("done", { title: "fresh", completedAt: NOW - 6 * DAY }),
      task("dropped", { title: "stale", completedAt: NOW - 8 * DAY }),
      // Updated long ago but completed recently: the completion decides.
      task("done", { title: "recent", completedAt: NOW - DAY, updatedAt: NOW - 30 * DAY }),
    ];
    const [group] = groupTasks(rows, { now: NOW });
    expect(group.tasks.map((item) => item.title)).toEqual(["recent", "fresh"]);
    expect(group.hidden).toBe(1);

    const [all] = groupTasks(rows, { now: NOW, showAllDone: true });
    expect(all.tasks.map((item) => item.title)).toEqual(["recent", "fresh", "stale"]);
    expect(all.hidden).toBe(0);
  });

  it("keeps a group of only old finished rows, for its show more", () => {
    const [group] = groupTasks([task("done", { completedAt: NOW - 20 * DAY })], { now: NOW });
    expect(group.key).toBe("done");
    expect(group.tasks).toEqual([]);
    expect(group.hidden).toBe(1);
  });

  it("never lists an archived row", () => {
    expect(groupTasks([task("doing", { archivedAt: NOW })], { now: NOW })).toEqual([]);
  });
});

describe("pillState", () => {
  it("counts Needs you first, then Doing, else idles", () => {
    expect(pillState([task("needs_user"), task("needs_user"), task("doing")])).toEqual({
      kind: "needsYou",
      count: 2,
    });
    expect(pillState([task("doing"), task("doing"), task("next"), task("watching")])).toEqual({
      kind: "doing",
      count: 2,
    });
    expect(pillState([task("next"), task("watching"), task("done")])).toEqual({ kind: "idle" });
    expect(pillState([])).toEqual({ kind: "idle" });
  });

  it("does not count archived rows", () => {
    expect(pillState([task("needs_user", { archivedAt: NOW })])).toEqual({ kind: "idle" });
    expect(needsYouCount([task("needs_user"), task("needs_user", { archivedAt: NOW })])).toBe(1);
  });
});

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

describe("taskTime", () => {
  it("is the due time of a watched or planned row, and the finish time of a finished one", () => {
    expect(taskTime(task("watching", { dueAt: NOW + 5 }))).toBe(NOW + 5);
    expect(taskTime(task("next", { dueAt: NOW + 7 }))).toBe(NOW + 7);
    expect(taskTime(task("watching"))).toBeNull();
    expect(taskTime(task("done", { completedAt: NOW - 9, updatedAt: NOW - 1 }))).toBe(NOW - 9);
    expect(taskTime(task("dropped", { completedAt: null, updatedAt: NOW - 1 }))).toBe(NOW - 1);
  });

  it("is nothing for a row the guardian is needed on or the Concierge is working on", () => {
    expect(taskTime(task("needs_user", { dueAt: NOW + 5 }))).toBeNull();
    expect(taskTime(task("doing", { dueAt: NOW + 5 }))).toBeNull();
  });
});
