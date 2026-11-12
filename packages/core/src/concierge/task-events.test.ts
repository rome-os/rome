import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  type DirtyTask,
  MIN_FLUSH_SPACING_MS,
  QUIET_DELAY_MS,
  RETRY_MS,
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
    carried: (taskId) => carried.has(taskId),
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

      // The Concierge writes the row during its turn, and the turn ends.
      s.coalescer.settle("a");
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

  it("keeps news that replaced a row's settled news while its report ran to its end", async () => {
    const s = setup();
    s.holdTurns();
    s.coalescer.mark(urgent("t1"));
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    expect(s.flushes).toHaveLength(1);
    // The Concierge says it in that turn, and new news comes before the turn ends.
    s.coalescer.settle("t1");
    s.coalescer.mark(urgent("t1", "approval"));
    await s.endTurn();
    expect(s.coalescer.pending).toContain("t1");
  });

  it("forgets only the news a turn said, not news that came after a flush took it", async () => {
    const s = setup();
    s.holdTurns();
    s.coalescer.mark(urgent("t1"));
    // A turn says it before any flush built it.
    const said = s.coalescer.snapshot("t1");
    await rs.advanceTimersByTimeAsync(URGENT_DELAY_MS);
    // A flush built it; then one new change starts a new round in the same entry.
    s.coalescer.mark(urgent("t1", "approval"));
    expect(s.coalescer.forgetSaid("t1", said)).toBe(false);
    expect(s.coalescer.pending).toContain("t1");
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
    s.coalescer.settle("a");
    s.coalescer.settle("b");
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
    s.coalescer.settle("a");
    await s.endTurn();
    expect(s.coalescer.pending).toEqual(["a"]);

    s.turnsRun(true);
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    await s.endTurn();
    expect(s.rendered[1]).toEqual(["turn_end:completed question by=concierge", "approval"]);
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
