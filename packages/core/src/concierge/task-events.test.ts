import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  type DirtyTask,
  MIN_FLUSH_SPACING_MS,
  QUIET_DELAY_MS,
  RETRY_MS,
  SILENCE_MS,
  TaskEventCoalescer,
  URGENT_DELAY_MS,
} from "./task-events.js";
import { currentSessionActor, runWithSessionActor } from "../access/session-actor.js";

const urgent = (taskId: string, kind = "turn_end:completed by=concierge") => ({
  taskId,
  kind,
  urgent: true,
});
const quiet = (taskId: string, kind = "guardian_message") => ({ taskId, kind, urgent: false });

function setup(carried: Set<string> = new Set()) {
  const flushes: Array<{ ids: string[]; quiet: boolean; at: number }> = [];
  const rendered: string[][] = [];
  const gaveUp: string[] = [];
  const reported: string[] = [];
  /** How the next turns end. */
  let outcome: "completed" | "stopped" | "interrupted" | "failed" = "completed";
  /** Settles the running flush's turn. */
  let endTurn: (() => void) | null = null;
  let holdTurns = false;
  const coalescer = new TaskEventCoalescer({
    now: () => Date.now(),
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
    reported: (taskIds) => reported.push(...taskIds),
    carried: (taskId) => carried.has(taskId),
  });
  return {
    coalescer,
    flushes,
    rendered,
    gaveUp,
    reported,
    /** Makes the next turns fail, as when the Concierge is out of quota, or run again. */
    turnsRun: (value: boolean) => {
      outcome = value ? "completed" : "failed";
    },
    /** Makes the next turns end the way a Stop ends them. */
    turnsStopped: () => {
      outcome = "stopped";
    },
    /** Makes the next turns end the way a newer message cuts them short. */
    turnsInterrupted: () => {
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

  it("drops a silenced row's held and new changes until the silence ends", async () => {
    const s = setup();
    s.coalescer.mark(quiet("t1"));
    s.coalescer.mark(quiet("t2"));
    s.coalescer.silence(["t1"]);
    s.coalescer.mark(urgent("t1", "turn_end:interrupted by=system"));
    expect(s.coalescer.pending).toEqual(["t2"]);
    await rs.advanceTimersByTimeAsync(QUIET_DELAY_MS);
    expect(s.flushes.map((flush) => flush.ids)).toEqual([["t2"]]);
    // Once the silence ends, the row is heard again.
    await rs.advanceTimersByTimeAsync(SILENCE_MS);
    s.coalescer.mark(urgent("t1"));
    expect(s.coalescer.pending).toEqual(["t1"]);
  });

  it("leaves out of a running flush the rows silenced while an earlier chat's turn ran", async () => {
    const sent: string[][] = [];
    const rendered: string[][] = [];
    let endFirst: (() => void) | null = null;
    // Each row's chat is the first letter of its id.
    const coalescer = new TaskEventCoalescer({
      now: () => Date.now(),
      render: async (tasks) => {
        rendered.push(tasks.map((task) => task.taskId));
        const byChat = new Map<string, string[]>();
        for (const { taskId } of tasks) {
          byChat.set(taskId[0]!, [...(byChat.get(taskId[0]!) ?? []), taskId]);
        }
        return [...byChat].map(([chatId, taskIds]) => ({
          chatId,
          owner: "guardian",
          taskIds,
          prompt: taskIds.join(","),
          quiet: true,
        }));
      },
      deliver: async ({ taskIds }) => {
        sent.push(taskIds);
        if (taskIds.includes("a1")) await new Promise<void>((resolve) => (endFirst = resolve));
        return "completed";
      },
      giveUp: () => {},
    });
    for (const taskId of ["a1", "b1", "b2", "c1"]) coalescer.mark(quiet(taskId));
    await rs.advanceTimersByTimeAsync(QUIET_DELAY_MS);
    expect(sent).toEqual([["a1"]]);
    // Chat b's and chat c's payloads were built; then b1 and c1 are silenced.
    coalescer.silence(["b1", "c1"]);
    endFirst!();
    await rs.advanceTimersByTimeAsync(0);
    // Chat b's turn tells b2 alone, built again without b1; chat c's has nothing left.
    expect(sent).toEqual([["a1"], ["b2"]]);
    expect(rendered.at(-1)).toEqual(["b2"]);
    expect(coalescer.pending).toEqual([]);
    coalescer.stop();
  });

  describe("awaitingReport", () => {
    it("holds an urgent row from its mark until the turn that reports it ends", async () => {
      const s = setup();
      const changes: string[][] = [];
      s.coalescer.onChange(() => changes.push(s.coalescer.awaitingReport));
      s.holdTurns();
      s.coalescer.mark(quiet("q"));
      s.coalescer.mark(urgent("a"));
      expect(s.coalescer.awaitingReport).toEqual(["a"]);

      // The flush builds and runs the turn: the row is still about to be reported.
      await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
      expect(s.flushes).toHaveLength(1);
      expect(s.coalescer.awaitingReport).toEqual(["a"]);

      // The turn ends.
      await s.endTurn();
      expect(s.coalescer.awaitingReport).toEqual([]);
      expect(changes.at(-1)).toEqual([]);
    });

    it("lets go of a row once the turn that carried it ran to its end", async () => {
      const s = setup();
      s.coalescer.mark(urgent("a"));
      await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
      expect(s.flushes).toHaveLength(1);
      expect(s.coalescer.pending).toEqual([]);
      expect(s.coalescer.awaitingReport).toEqual([]);
    });

    it("lets go of a row waiting out a turn that did not run", async () => {
      const s = setup();
      s.turnsRun(false);
      s.coalescer.mark(urgent("a"));
      await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
      expect(s.coalescer.awaitingReport).toEqual([]);
      await rs.advanceTimersByTimeAsync(RETRY_MS);
      expect(s.flushes).toHaveLength(2);
    });
  });

  describe("every change is reported, whatever the report turn does", () => {
    const arrivals = ["before", "during", "after"] as const;
    const outcomes = ["completed", "failed", "interrupted", "stopped"] as const;
    for (const arrival of arrivals) {
      for (const outcome of outcomes) {
        it(`news ${arrival} a report turn that ends ${outcome}`, async () => {
          const s = setup();
          s.holdTurns();
          s.coalescer.mark(urgent("a", "first"));
          if (arrival === "before") s.coalescer.mark(urgent("a", "second"));
          await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
          expect(s.flushes).toHaveLength(1);
          if (arrival === "during") s.coalescer.mark(urgent("a", "second"));
          if (outcome === "failed") s.turnsRun(false);
          if (outcome === "interrupted") s.turnsInterrupted();
          if (outcome === "stopped") s.turnsStopped();
          await s.endTurn();
          if (arrival === "after") s.coalescer.mark(urgent("a", "second"));
          // Every later turn runs to its end.
          s.turnsRun(true);
          for (let round = 0; round < 6 && s.coalescer.pending.length > 0; round += 1) {
            await rs.advanceTimersByTimeAsync(RETRY_MS);
            await s.endTurn();
          }
          const said = s.rendered.flat();
          // A Stop gives up what its turn carried, and only that.
          const stoppedCarried = outcome === "stopped" ? s.rendered[0] : [];
          for (const change of ["first", "second"]) {
            if (stoppedCarried?.includes(change)) {
              // Given up, unless newer news brought the task to a report of
              // its own: a report reads the task as it is now.
              expect(s.gaveUp.includes("a") || s.flushes.length > 1).toBe(true);
            } else {
              expect(said.filter((kind) => kind === change).length).toBeGreaterThan(0);
            }
          }
          expect(s.coalescer.pending).toEqual([]);
          expect(s.coalescer.awaitingReport).toEqual([]);
        });
      }
    }
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
    s.coalescer.mark(urgent("b"));
    await rs.advanceTimersByTimeAsync(60_000);
    expect(s.flushes).toHaveLength(1);
    await s.endTurn();
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    expect(s.flushes.map((flush) => flush.ids)).toEqual([["a"], ["b"]]);
  });

  it("keeps a row dirty when a change arrives after the build, even if the Concierge writes it", async () => {
    const s = setup();
    s.holdTurns();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // The change lands while the flush's turn runs, after the payload was built.
    await rs.advanceTimersByTimeAsync(1_000);
    s.coalescer.mark(urgent("a", "turn_end:completed by=concierge second"));
    expect(s.coalescer.pending).toEqual(["a"]);
    await s.endTurn();
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS + URGENT_DELAY_MS);
    expect(s.flushes.map((flush) => flush.ids)).toEqual([["a"], ["a"]]);
  });

  it("delivers a row once: a turn that ran to its end settles it, with no write and no retry", async () => {
    const s = setup();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    expect(s.coalescer.pending).toEqual([]);
    await rs.advanceTimersByTimeAsync(10 * QUIET_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    expect(s.gaveUp).toEqual([]);
  });

  it("tries a row again 5 min after a turn that did not run, until one runs", async () => {
    const s = setup();
    s.turnsRun(false);
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    await rs.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(s.flushes).toHaveLength(1);
    await rs.advanceTimersByTimeAsync(1);
    expect(s.flushes).toHaveLength(2);

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.flushes).toHaveLength(3);
    expect(s.coalescer.pending).toEqual([]);
    expect(s.gaveUp).toEqual([]);
  });

  it("keeps changes that arrive while turns fail, and a write settles nothing a failed turn never brought", async () => {
    const s = setup();
    s.turnsRun(false);
    s.coalescer.mark(urgent("a", "turn_end:error by=concierge"));
    s.coalescer.mark(urgent("b"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    s.coalescer.mark(urgent("a", "turn_end:completed by=concierge"));
    // The Concierge wrote both rows in a turn of its own, such as a title
    // edit: it never got their news, so the retry still owes it.
    expect(s.coalescer.pending).toEqual(["a", "b"]);

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.flushes.map((flush) => flush.ids)).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(s.rendered[1]).toEqual([
      "turn_end:error by=concierge",
      "turn_end:completed by=concierge",
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
    await s.endTurn();
    expect(s.coalescer.pending).toEqual(["a"]);

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    await s.endTurn();
    expect(s.rendered[1]).toEqual(["turn_end:completed question by=concierge", "approval"]);
    expect(s.coalescer.pending).toEqual([]);
  });

  it("still retries news a failing turn carried when a change needing no word arrives while it runs", async () => {
    const s = setup();
    s.turnsRun(false);
    s.holdTurns();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // A scheduled turn finishes with nothing to say while the report turn runs, which then fails.
    await rs.advanceTimersByTimeAsync(1_000);
    s.coalescer.mark({
      taskId: "a",
      kind: "turn_end:completed by=system",
      urgent: false,
      passive: true,
    });
    await s.endTurn();
    expect(s.coalescer.passiveOf(["a"])).toEqual([]);

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    await s.endTurn();
    expect(s.flushes).toHaveLength(2);
    expect(s.rendered[1]).toEqual([
      "turn_end:completed by=concierge",
      "turn_end:completed by=system",
    ]);
    expect(s.coalescer.pending).toEqual([]);
  });

  it("delivers a change that arrives during the wait with the next turn that runs", async () => {
    const s = setup();
    s.turnsRun(false);
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    s.coalescer.mark(urgent("a", "approval"));

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.flushes).toHaveLength(2);
    expect(s.rendered[1]).toContain("approval");
    expect(s.coalescer.pending).toEqual([]);
  });

  it("wakes no turn for a change that needs no word, and takes it along with the next flush", async () => {
    const s = setup();
    s.coalescer.mark({
      taskId: "a",
      kind: "turn_end:completed by=system",
      urgent: false,
      passive: true,
    });
    await rs.advanceTimersByTimeAsync(10 * QUIET_DELAY_MS);
    expect(s.flushes).toEqual([]);
    expect(s.coalescer.pending).toEqual(["a"]);
    s.coalescer.mark(urgent("b"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes.map((flush) => flush.ids)).toEqual([["a", "b"]]);
  });

  it("hands a change that needs no word to the digest, and a row with any other change to its flush", async () => {
    const s = setup();
    s.coalescer.mark({
      taskId: "a",
      kind: "turn_end:completed by=system",
      urgent: false,
      passive: true,
    });
    s.coalescer.mark({
      taskId: "b",
      kind: "turn_end:completed by=system",
      urgent: false,
      passive: true,
    });
    s.coalescer.mark(urgent("b", "approval"));
    expect(s.coalescer.passiveOf(["a", "b"])).toEqual(["a"]);
    // Read only, until the digest that listed them ran to its end.
    expect(s.coalescer.pending).toEqual(["a", "b"]);
    s.coalescer.settlePassive(["a", "b"]);
    expect(s.coalescer.pending).toEqual(["b"]);
  });

  it("hands back what a failing turn carried though it wrote the row before it failed", async () => {
    const s = setup();
    s.turnsRun(false);
    s.holdTurns();
    s.coalescer.mark(urgent("a", "turn_end:completed question by=concierge"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // The report turn wrote the row (a title, a note), then failed before it
    // said the result: the result is still owed, with the change after it.
    await rs.advanceTimersByTimeAsync(1_000);
    s.coalescer.mark(urgent("a", "approval"));
    await s.endTurn();

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    await s.endTurn();
    expect(s.rendered.at(-1)).toEqual(["turn_end:completed question by=concierge", "approval"]);
  });

  it("never hands the changes of a turn the guardian stopped over again, but still delivers one that came while it ran", async () => {
    const s = setup();
    s.turnsStopped();
    s.holdTurns();
    s.coalescer.mark(urgent("a"));
    s.coalescer.mark(urgent("b"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // The guardian presses Stop, and a change for "b" lands while the turn ends.
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

  it("counts a result the stopped turn said before the Stop as said, and gives up the rest", async () => {
    const s = setup();
    s.turnsStopped();
    s.holdTurns();
    s.coalescer.mark(urgent("a"));
    s.coalescer.mark(urgent("b"));
    // Saying it before any turn carries the news counts for nothing.
    s.coalescer.said("b");
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // The report turn says "a", then the guardian presses Stop.
    s.coalescer.said("a");
    await s.endTurn();
    expect(s.coalescer.pending).toEqual([]);
    expect(s.reported).toEqual(["a"]);
    expect(s.gaveUp).toEqual(["b"]);
  });

  it("tries a report a newer message cut short again with the next flush, not minutes later", async () => {
    const s = setup();
    s.turnsInterrupted();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    // Still owed: its task reads as active until the news is said.
    expect(s.coalescer.pending).toEqual(["a"]);
    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(2);
    // Said: nothing is owed, so its task leaves Active.
    expect(s.coalescer.pending).toEqual([]);
    expect(s.gaveUp).toEqual([]);
  });

  it("waits for the turn that took a cut-short report over, which may say it itself", async () => {
    const carried = new Set<string>();
    const s = setup(carried);
    s.turnsInterrupted();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // The guardian's turn that cut it short now carries its news.
    carried.add("a");
    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(3 * MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(1);
    // That turn ended without saying it: the next flush does.
    carried.delete("a");
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(2);
    expect(s.coalescer.pending).toEqual([]);
  });

  it("waits for a turn that carries a cut-short report no longer than RETRY_MS", async () => {
    const carried = new Set<string>(["a"]);
    const s = setup(carried);
    s.turnsInterrupted();
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    s.turnsRun(true);
    // The turn that took it over never ends, as after a crash.
    await rs.advanceTimersByTimeAsync(RETRY_MS + MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(2);
    expect(s.coalescer.pending).toEqual([]);
  });

  it("still waits RETRY_MS after a report that failed", async () => {
    const s = setup();
    s.turnsRun(false);
    s.coalescer.mark(urgent("a"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(3 * MIN_FLUSH_SPACING_MS);
    expect(s.flushes).toHaveLength(1);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.flushes).toHaveLength(2);
  });

  it("waits to retry only the rows of a chat whose turn did not run", async () => {
    const delivered: string[] = [];
    const coalescer = new TaskEventCoalescer({
      now: () => Date.now(),
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
    // "b" ran: it is settled. "a" waits for its retry.
    expect(delivered).toEqual(["a", "b"]);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(delivered).toEqual(["a", "b", "a"]);
  });

  it("still delivers the other chats' turns when one chat's turn fails", async () => {
    const delivered: Array<string | null> = [];
    const coalescer = new TaskEventCoalescer({
      now: () => Date.now(),
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

describe("TaskEventCoalescer and session actors", () => {
  it("runs every owner's turns as no one, whichever person's request marked the last row", async () => {
    const seen: Array<{ owner: string; actor: unknown }> = [];
    const coalescer = new TaskEventCoalescer({
      now: () => Date.now(),
      render: async (tasks) =>
        tasks.map((task) => ({
          chatId: task.taskId === "v" ? "visitor-topic" : null,
          owner: task.taskId === "v" ? "visitor:acct-v" : "guardian",
          taskIds: [task.taskId],
          prompt: task.taskId,
          quiet: false,
        })),
      deliver: async ({ owner }) => {
        seen.push({ owner, actor: await currentSessionActor() });
        return "completed";
      },
      giveUp: () => {},
    });
    coalescer.mark(urgent("g"));
    // The visitor's request marks the last row, which arms the timer.
    await runWithSessionActor(
      { kind: "visitor", accountId: "acct-v", email: "v@example.com" },
      () => coalescer.mark(urgent("v")),
    );
    await new Promise((resolve) => setTimeout(resolve, URGENT_DELAY_MS + 200));
    coalescer.stop();
    expect(seen).toEqual([
      { owner: "guardian", actor: undefined },
      { owner: "visitor:acct-v", actor: undefined },
    ]);
  });
});
