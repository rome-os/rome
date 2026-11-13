import { describe, expect, it } from "@rstest/core";
import type { ConciergeTaskDto, ConciergeTaskState } from "@rome/api-types/concierge";
import {
  type ConciergeTaskEndReason,
  type ConciergeTaskStatus,
  legacyTaskState,
} from "@rome/api-types/concierge-task-status";
import { applyTaskUpsert, formatTaskTime, groupTasks, taskTime } from "./tasks";

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

/** A row Rome sent with `status`, its old state mapped from it. */
function withStatus(
  status: ConciergeTaskStatus,
  extra: Partial<ConciergeTaskDto> = {},
  endReason: ConciergeTaskEndReason | null = status === "ended" ? "done" : null,
): ConciergeTaskDto {
  return task(legacyTaskState({ status, endReason }), { status, endReason, ...extra });
}

describe("groupTasks", () => {
  it("shows the four groups in order and leaves empty ones out", () => {
    const groups = groupTasks(
      [
        withStatus("ended", { completedAt: NOW - DAY }),
        withStatus("later"),
        withStatus("active"),
        withStatus("needs_you"),
      ],
      { now: NOW },
    );
    expect(groups.map((group) => group.key)).toEqual(["needsYou", "active", "later", "ended"]);
    expect(groupTasks([withStatus("active")], { now: NOW }).map((group) => group.key)).toEqual([
      "active",
    ]);
    expect(groupTasks([], { now: NOW })).toEqual([]);
  });

  it("groups by the status Rome sent, not the state the row once had", () => {
    const [group] = groupTasks([task("doing", { status: "ended", endReason: "failed" })], {
      now: NOW,
    });
    expect(group.key).toBe("ended");
  });

  it("reads a row from a server before status by its state", () => {
    const groups = groupTasks(
      [task("needs_user"), task("doing"), task("next"), task("watching"), task("dropped")],
      { now: NOW },
    );
    expect(groups.map((group) => [group.key, group.tasks.length])).toEqual([
      ["needsYou", 1],
      ["active", 1],
      ["later", 2],
      ["ended", 1],
    ]);
  });

  it("orders Later by its check, the soonest first, and Waiting for you by the oldest wait", () => {
    const groups = groupTasks(
      [
        withStatus("later", { title: "far", laterAt: NOW + 2 * DAY }),
        withStatus("later", { title: "undated" }),
        withStatus("later", { title: "soon", laterAt: NOW + DAY }),
        withStatus("needs_you", { title: "new", waitingSince: NOW - 1000 }),
        withStatus("needs_you", { title: "old", waitingSince: NOW - DAY }),
      ],
      { now: NOW },
    );
    const titles = (key: string) =>
      groups.find((group) => group.key === key)?.tasks.map((item) => item.title);
    expect(titles("later")).toEqual(["soon", "far", "undated"]);
    expect(titles("needsYou")).toEqual(["old", "new"]);
  });

  it("puts every ended row together, whatever its reason, newest first", () => {
    const [ended] = groupTasks(
      [
        withStatus("ended", { title: "older", completedAt: NOW - 3 * DAY }),
        withStatus("ended", { title: "newer", completedAt: NOW - DAY }, "failed"),
      ],
      { now: NOW },
    );
    expect(ended.tasks.map((item) => item.title)).toEqual(["newer", "older"]);
  });

  it("shows ended rows of the last 7 days and holds older ones behind show more", () => {
    const rows = [
      withStatus("ended", { title: "fresh", completedAt: NOW - 6 * DAY }),
      withStatus("ended", { title: "stale", completedAt: NOW - 8 * DAY }, "stopped"),
      // Updated long ago but completed recently: the completion decides.
      withStatus("ended", { title: "recent", completedAt: NOW - DAY, updatedAt: NOW - 30 * DAY }),
    ];
    const [group] = groupTasks(rows, { now: NOW });
    expect(group.tasks.map((item) => item.title)).toEqual(["recent", "fresh"]);
    expect(group.hidden).toBe(1);

    const [all] = groupTasks(rows, { now: NOW, showAllDone: true });
    expect(all.tasks.map((item) => item.title)).toEqual(["recent", "fresh", "stale"]);
    expect(all.hidden).toBe(0);
  });

  it("keeps a group of only old ended rows, for its show more", () => {
    const [group] = groupTasks([withStatus("ended", { completedAt: NOW - 20 * DAY })], {
      now: NOW,
    });
    expect(group.key).toBe("ended");
    expect(group.tasks).toEqual([]);
    expect(group.hidden).toBe(1);
  });

  it("never lists an archived row", () => {
    expect(groupTasks([task("doing", { archivedAt: NOW })], { now: NOW })).toEqual([]);
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
    // A later row's check, once Rome sends it.
    expect(taskTime(withStatus("later", { laterAt: NOW + 3, dueAt: NOW + 5 }))).toBe(NOW + 3);
    // A row whose task chat has not started is later with no time, whatever it was due.
    expect(taskTime(withStatus("later", { laterAt: null, dueAt: NOW - 5 }))).toBeNull();
  });

  it("is nothing for a row the guardian is needed on or the Concierge is working on", () => {
    expect(taskTime(task("needs_user", { dueAt: NOW + 5 }))).toBeNull();
    expect(taskTime(task("doing", { dueAt: NOW + 5 }))).toBeNull();
  });
});
