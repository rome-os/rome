import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  type DirtyTask,
  MIN_FLUSH_SPACING_MS,
  QUIET_DELAY_MS,
  TaskEventCoalescer,
  URGENT_DELAY_MS,
} from "./task-events.js";

const urgent = (taskId: string, kind = "turn_end:completed by=concierge") => ({
  taskId,
  kind,
  urgent: true,
});
const quiet = (taskId: string, kind = "guardian_message") => ({ taskId, kind, urgent: false });

function setup() {
  const flushes: Array<{ ids: string[]; quiet: boolean; at: number }> = [];
  const gaveUp: string[] = [];
  /** Settles the running flush's turn. */
  let endTurn: (() => void) | null = null;
  let holdTurns = false;
  /** What the next turns report: the guardian pressed Stop on them. */
  let stopTurns = false;
  const coalescer = new TaskEventCoalescer({
    now: () => Date.now(),
    isEnabled: async () => true,
    render: async (tasks: DirtyTask[]) => tasks.map((task) => task.taskId).join(","),
    deliver: async (prompt, options) => {
      flushes.push({ ids: prompt.split(","), quiet: options.quiet, at: Date.now() });
      if (holdTurns) await new Promise<void>((resolve) => (endTurn = resolve));
      return { stopped: stopTurns };
    },
    giveUp: (taskId) => gaveUp.push(taskId),
  });
  return {
    coalescer,
    flushes,
    gaveUp,
    holdTurns: () => {
      holdTurns = true;
    },
    stopTurns: () => {
      stopTurns = true;
    },
    endTurn: async () => {
      endTurn?.();
      await rs.advanceTimersByTimeAsync(0);
    },
  };
}

describe("TaskEventCoalescer", () => {
  beforeEach(() => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
  });
  afterEach(() => {
    rs.useRealTimers();
  });

  it("flushes an urgent change after 2 s, as one non-quiet batch", async () => {
    const s = setup();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS - 1);
    expect(s.flushes).toEqual([]);
    await rs.advanceTimersByTimeAsync(1);
    expect(s.flushes).toMatchObject([{ ids: ["a"], quiet: false }]);
  });

  it("waits 60 s for quiet changes, and flushes them as a quiet batch", async () => {
    const s = setup();
    s.coalescer.mark(quiet("a"));
    await rs.advanceTimersByTimeAsync(QUIET_DELAY_MS - 1);
    expect(s.flushes).toEqual([]);
    await rs.advanceTimersByTimeAsync(1);
    expect(s.flushes).toMatchObject([{ ids: ["a"], quiet: true }]);
  });

  it("lets a quiet change ride along with the next urgent flush", async () => {
    const s = setup();
    s.coalescer.mark(quiet("a"));
    await rs.advanceTimersByTimeAsync(5_000);
    s.coalescer.mark(urgent("b"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toMatchObject([{ ids: ["a", "b"], quiet: false }]);
  });

  it("batches rows that go urgent together into one flush", async () => {
    const s = setup();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(500);
    s.coalescer.mark(urgent("b"));
    s.coalescer.mark(urgent("c"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    expect(s.flushes[0].ids).toEqual(["a", "b", "c"]);
  });

  it("keeps at least 10 s between flushes", async () => {
    const s = setup();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    const first = s.flushes[0].at;
    s.coalescer.settle("a");
    s.coalescer.mark(urgent("b"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(2);
    expect(s.flushes[1].at - first).toBe(MIN_FLUSH_SPACING_MS);
  });

  it("runs one flush at a time", async () => {
    const s = setup();
    s.holdTurns();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    s.coalescer.settle("a");
    s.coalescer.mark(urgent("b"));
    await rs.advanceTimersByTimeAsync(60_000);
    expect(s.flushes).toHaveLength(1);
    await s.endTurn();
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    expect(s.flushes.map((flush) => flush.ids)).toEqual([["a"], ["b"]]);
  });

  it("clears a row when the Concierge writes it after the build", async () => {
    const s = setup();
    s.holdTurns();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    s.coalescer.settle("a");
    await s.endTurn();
    expect(s.coalescer.pending).toEqual([]);
    await rs.advanceTimersByTimeAsync(10 * MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(1);
  });

  it("ignores a write before any build: the row has not been delivered yet", async () => {
    const s = setup();
    s.coalescer.mark(urgent("a"));
    s.coalescer.settle("a");
    expect(s.coalescer.pending).toEqual(["a"]);
  });

  it("keeps a row dirty when a change arrives after the build, even if the Concierge writes it", async () => {
    const s = setup();
    s.holdTurns();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // The change lands while the flush's turn runs, after the payload was built.
    await rs.advanceTimersByTimeAsync(1_000);
    s.coalescer.mark(urgent("a", "turn_end:completed by=concierge second"));
    s.coalescer.settle("a");
    expect(s.coalescer.pending).toEqual(["a"]);
    await s.endTurn();
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS + URGENT_DELAY_MS);
    expect(s.flushes.map((flush) => flush.ids)).toEqual([["a"], ["a"]]);
  });

  it("flushes an unwritten row once more, then gives it up as not synced", async () => {
    const s = setup();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    expect(s.gaveUp).toEqual([]);
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(2);
    expect(s.gaveUp).toEqual(["a"]);
    expect(s.coalescer.pending).toEqual([]);
    await rs.advanceTimersByTimeAsync(10 * QUIET_DELAY_MS);
    expect(s.flushes).toHaveLength(2);
  });

  it("drops the rows of a flush the guardian stopped, with no retry and no give-up", async () => {
    const s = setup();
    s.stopTurns();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    expect(s.coalescer.pending).toEqual([]);
    await rs.advanceTimersByTimeAsync(10 * QUIET_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    expect(s.gaveUp).toEqual([]);
  });

  it("keeps a change that came after the build of a stopped flush for its own flush", async () => {
    const s = setup();
    s.holdTurns();
    s.stopTurns();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    await rs.advanceTimersByTimeAsync(1_000);
    s.coalescer.mark(urgent("a", "turn_end:completed by=concierge second"));
    s.coalescer.mark(urgent("b"));
    await s.endTurn();
    // `b` was marked after the build too, so both wait for the next flush.
    expect(s.coalescer.pending).toEqual(["a", "b"]);
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS + URGENT_DELAY_MS);
    expect(s.flushes.map((flush) => flush.ids)).toEqual([["a"], ["a", "b"]]);
    expect(s.gaveUp).toEqual([]);
  });

  it("still retries a flush whose turn a new message superseded", async () => {
    // A superseded turn reports no stop: `deliver` resolves with nothing.
    const flushes: string[] = [];
    const gaveUp: string[] = [];
    const coalescer = new TaskEventCoalescer({
      now: () => Date.now(),
      isEnabled: async () => true,
      render: async (tasks: DirtyTask[]) => tasks.map((task) => task.taskId).join(","),
      deliver: async (prompt) => {
        flushes.push(prompt);
      },
      giveUp: (taskId) => gaveUp.push(taskId),
    });
    coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS + MIN_FLUSH_SPACING_MS);
    expect(flushes).toEqual(["a", "a"]);
    expect(gaveUp).toEqual(["a"]);
  });

  it("does not give up a row whose retry the Concierge wrote", async () => {
    const s = setup();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS + MIN_FLUSH_SPACING_MS - 1);
    expect(s.flushes).toHaveLength(1);
    s.coalescer.settle("a");
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(1);
    expect(s.gaveUp).toEqual([]);
  });

  it("drops marks when the setting turns off, without delivering", async () => {
    const delivered: string[] = [];
    const coalescer = new TaskEventCoalescer({
      now: () => Date.now(),
      isEnabled: async () => false,
      render: async () => "x",
      deliver: async (prompt) => {
        delivered.push(prompt);
      },
      giveUp: () => {},
    });
    coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(delivered).toEqual([]);
    expect(coalescer.pending).toEqual([]);
  });
});
