import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  type DirtyTask,
  MIN_FLUSH_SPACING_MS,
  QUIET_DELAY_MS,
  RETRY_MS,
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
  const rendered: string[][] = [];
  const gaveUp: string[] = [];
  /** How the next turns end. */
  let outcome: "completed" | "interrupted" | "failed" = "completed";
  /** Settles the running flush's turn. */
  let endTurn: (() => void) | null = null;
  let holdTurns = false;
  const coalescer = new TaskEventCoalescer({
    now: () => Date.now(),
    isEnabled: async () => true,
    render: async (tasks: DirtyTask[]) => {
      rendered.push(tasks.flatMap((task) => task.changes.map((change) => change.kind)));
      return [
        {
          chatId: null,
          owner: "guardian",
          taskIds: tasks.map((task) => task.taskId),
          prompt: tasks.map((task) => task.taskId).join(","),
          quiet: tasks.every((task) => task.quiet),
        },
      ];
    },
    deliver: async ({ prompt, quiet }) => {
      flushes.push({ ids: prompt.split(","), quiet, at: Date.now() });
      if (holdTurns) await new Promise<void>((resolve) => (endTurn = resolve));
      return outcome;
    },
    giveUp: (taskId) => gaveUp.push(taskId),
  });
  return {
    coalescer,
    flushes,
    rendered,
    gaveUp,
    /** Makes the next turns fail, as when the Concierge is out of quota, or run again. */
    turnsRun: (value: boolean) => {
      outcome = value ? "completed" : "failed";
    },
    /** Makes the next turns end the way a Stop or a newer message ends them. */
    turnsStopped: () => {
      outcome = "interrupted";
    },
    holdTurns: () => {
      holdTurns = true;
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

  it("tries a row again 5 min after a turn that did not run, without spending its retries", async () => {
    const s = setup();
    s.turnsRun(false);
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    await rs.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(s.flushes).toHaveLength(1);
    await rs.advanceTimersByTimeAsync(1);
    expect(s.flushes).toHaveLength(2);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.flushes).toHaveLength(3);
    expect(s.gaveUp).toEqual([]);

    // Turns run again: the row still has its flush and its retry before it is given up.
    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.flushes).toHaveLength(4);
    expect(s.gaveUp).toEqual([]);
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(5);
    expect(s.gaveUp).toEqual(["a"]);
  });

  it("keeps changes that arrive while turns fail, and a write still settles what a turn carried", async () => {
    const s = setup();
    s.turnsRun(false);
    s.coalescer.mark(urgent("a", "turn_end:error by=concierge"));
    s.coalescer.mark(urgent("b"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    s.coalescer.mark(urgent("a", "turn_end:completed by=concierge"));
    // The Concierge wrote both rows in a turn of its own: only "a" has a change no turn carried.
    s.coalescer.settle("a");
    s.coalescer.settle("b");
    expect(s.coalescer.pending).toEqual(["a"]);

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.flushes.map((flush) => flush.ids)).toEqual([["a", "b"], ["a"]]);
    expect(s.rendered[1]).toEqual([
      "turn_end:error by=concierge",
      "turn_end:completed by=concierge",
    ]);
  });

  it("keeps the changes a failing turn carried when another arrives while it runs", async () => {
    const s = setup();
    s.turnsRun(false);
    s.holdTurns();
    s.coalescer.mark(urgent("a", "turn_end:completed question by=concierge"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // The change lands while the turn runs; the turn then does not run to its end.
    await rs.advanceTimersByTimeAsync(1_000);
    s.coalescer.mark(urgent("a", "approval"));
    s.coalescer.settle("a");
    await s.endTurn();
    expect(s.coalescer.pending).toEqual(["a"]);

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    await s.endTurn();
    expect(s.rendered[1]).toEqual(["turn_end:completed question by=concierge", "approval"]);
    // The attempt did not count: the row still gets its retry before it is given up.
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    await s.endTurn();
    expect(s.flushes).toHaveLength(3);
    expect(s.gaveUp).toEqual(["a"]);
  });

  it("gives a change that arrives during the wait its own attempts", async () => {
    const s = setup();
    s.coalescer.mark(urgent("a"));
    // The first turn runs without writing the row; its retry then does not run.
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    s.turnsRun(false);
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(2);
    s.coalescer.mark(urgent("a", "approval"));

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.flushes).toHaveLength(3);
    expect(s.gaveUp).toEqual([]);
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(4);
    expect(s.gaveUp).toEqual(["a"]);
  });

  it("does not hand back changes a write settled while a failing turn ran", async () => {
    const s = setup();
    s.turnsRun(false);
    s.holdTurns();
    s.coalescer.mark(urgent("a", "turn_end:completed question by=concierge"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // The Concierge wrote the row from the turn's input; then a new change came.
    s.coalescer.settle("a");
    await rs.advanceTimersByTimeAsync(1_000);
    s.coalescer.mark(urgent("a", "approval"));
    await s.endTurn();

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    await s.endTurn();
    expect(s.rendered.at(-1)).toEqual(["approval"]);
  });

  it("never hands the changes of a turn the guardian stopped over again, but still delivers one that came while it ran", async () => {
    const s = setup();
    s.turnsStopped();
    s.holdTurns();
    s.coalescer.mark(urgent("a"));
    s.coalescer.mark(urgent("b"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // The guardian presses Stop, and a change for "b" lands while the turn ends.
    s.coalescer.guardianStopped();
    await rs.advanceTimersByTimeAsync(1_000);
    s.coalescer.mark(urgent("b", "approval"));
    await s.endTurn();
    expect(s.coalescer.pending).toEqual(["b"]);
    expect(s.gaveUp).toEqual(["a"]);

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    await s.endTurn();
    expect(s.flushes.map((flush) => flush.ids)).toEqual([["a", "b"], ["b"]]);
    expect(s.rendered[1]).toEqual(["approval"]);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    await s.endTurn();
    expect(
      s.flushes
        .map((flush) => flush.ids)
        .flat()
        .filter((id) => id === "a"),
    ).toHaveLength(1);
  });

  it("tries a turn a newer message cut short again, since it may never have reached the model", async () => {
    const s = setup();
    s.turnsStopped();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.flushes).toHaveLength(2);
    expect(s.gaveUp).toEqual([]);
  });

  it("ignores a Stop while no task-event turn is delivering", async () => {
    const s = setup();
    s.coalescer.guardianStopped();
    s.turnsStopped();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.coalescer.pending).toEqual(["a"]);
    expect(s.gaveUp).toEqual([]);
  });

  it("waits to retry only the rows of a chat whose turn did not run", async () => {
    const delivered: string[] = [];
    const coalescer = new TaskEventCoalescer({
      now: () => Date.now(),
      isEnabled: async () => true,
      render: async (tasks) =>
        tasks.map((task) => ({
          chatId: task.taskId === "a" ? "topic-1" : null,
          owner: "guardian",
          taskIds: [task.taskId],
          prompt: task.taskId,
          quiet: false,
        })),
      deliver: async ({ chatId, prompt }) => {
        delivered.push(prompt);
        return chatId === "topic-1" ? "failed" : "completed";
      },
      giveUp: () => {},
    });
    coalescer.mark(urgent("a"));
    coalescer.mark(urgent("b"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS + MIN_FLUSH_SPACING_MS);
    // "b" ran and was not written, so it gets its retry now; "a" waits.
    expect(delivered).toEqual(["a", "b", "b"]);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(delivered).toEqual(["a", "b", "b", "a"]);
  });

  it("drops marks when the setting turns off, without delivering", async () => {
    const delivered: string[] = [];
    const coalescer = new TaskEventCoalescer({
      now: () => Date.now(),
      isEnabled: async () => false,
      render: async () => [
        { chatId: null, owner: "guardian", taskIds: ["a"], prompt: "x", quiet: false },
      ],
      deliver: async ({ prompt }) => {
        delivered.push(prompt);
        return "completed";
      },
      giveUp: () => {},
    });
    coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(delivered).toEqual([]);
    expect(coalescer.pending).toEqual([]);
  });

  it("still delivers the other chats' turns when one chat's turn fails", async () => {
    const delivered: Array<string | null> = [];
    const coalescer = new TaskEventCoalescer({
      now: () => Date.now(),
      isEnabled: async () => true,
      render: async () => [
        { chatId: "topic-1", owner: "guardian", taskIds: ["a"], prompt: "a", quiet: false },
        { chatId: null, owner: "guardian", taskIds: ["b"], prompt: "b", quiet: false },
      ],
      deliver: async ({ chatId }) => {
        if (chatId === "topic-1") throw new Error("no runtime");
        delivered.push(chatId);
        return "completed";
      },
      giveUp: () => {},
    });
    coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(delivered).toEqual([null]);
  });

  it("delivers one turn per Concierge chat the rows came from, in one flush", async () => {
    const delivered: Array<{ chatId: string | null; prompt: string; quiet: boolean }> = [];
    const coalescer = new TaskEventCoalescer({
      now: () => Date.now(),
      isEnabled: async () => true,
      // Rows "a" and "b" came from a topic chat, "c" from the main chat.
      render: async (tasks) => {
        const topic = tasks.filter((task) => task.taskId !== "c");
        const main = tasks.filter((task) => task.taskId === "c");
        return [
          ...(topic.length
            ? [
                {
                  chatId: "topic-1",
                  owner: "guardian",
                  taskIds: topic.map((t) => t.taskId),
                  prompt: topic.map((t) => t.taskId).join(","),
                  quiet: false,
                },
              ]
            : []),
          ...(main.length
            ? [{ chatId: null, owner: "guardian", taskIds: ["c"], prompt: "c", quiet: true }]
            : []),
        ];
      },
      deliver: async (delivery) => {
        delivered.push(delivery);
        return "completed";
      },
      giveUp: () => {},
    });
    coalescer.mark(urgent("a"));
    coalescer.mark(urgent("b"));
    coalescer.mark(quiet("c"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(delivered).toEqual([
      { chatId: "topic-1", owner: "guardian", taskIds: ["a", "b"], prompt: "a,b", quiet: false },
      { chatId: null, owner: "guardian", taskIds: ["c"], prompt: "c", quiet: true },
    ]);
  });
});
