import { getEventListeners } from "node:events";
import { beforeEach, describe, expect, it } from "@rstest/core";
import { FakeClock } from "../../test/kit/clock.js";
import { Outlasted, Pacer, SKIPPED } from "./pacer.js";
import type { Budget } from "./types.js";

describe("Pacer", () => {
  let clock: FakeClock;
  let log: string[];
  const start = new Date("2026-01-01T00:00:00Z").getTime();

  beforeEach(() => {
    clock = new FakeClock(new Date(start));
    log = [];
  });

  /** Lets finished writes schedule what comes next, then moves time on. */
  const advance = async (duration: number | string) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await clock.advance(duration);
  };

  const pacer = (budget: Partial<Budget> = {}) =>
    new Pacer({ burst: 100, refillMs: 1, conversationSpacingMs: 0, ...budget }, clock);

  /** A write that logs its label and the time it started. */
  const write = (label: string) => async () => {
    log.push(`${label}@${clock.now().getTime() - start}`);
    return label;
  };

  it("resolves a caller with the write's result once the write has run", async () => {
    const result = pacer().run("a", write("hi"));
    await expect(result).resolves.toBe("hi");
    expect(log).toEqual(["hi@0"]);
  });

  it("keeps one conversation's writes in order, spaced apart", async () => {
    const paced = pacer({ conversationSpacingMs: 1000 });
    const writes = [
      paced.run("a", write("1")),
      paced.run("a", write("2")),
      paced.run("a", write("3")),
    ];
    await advance("5s");
    await Promise.all(writes);
    expect(log).toEqual(["1@0", "2@1000", "3@2000"]);
  });

  it("serves a ready conversation while another waits out its spacing", async () => {
    const paced = pacer({ conversationSpacingMs: 10_000 });
    await paced.run("a", write("a1"));
    const later = paced.run("a", write("a2"));
    await advance("1s");
    const ready = paced.run("b", write("b1"));
    await advance(0);
    expect(log).toEqual(["a1@0", "b1@1000"]);
    await advance("10s");
    await Promise.all([later, ready]);
    expect(log).toEqual(["a1@0", "b1@1000", "a2@10000"]);
  });

  it("lets conversations take turns instead of draining one queue first", async () => {
    const paced = pacer();
    const writes = [
      paced.run("a", write("a1")),
      paced.run("a", write("a2")),
      paced.run("a", write("a3")),
      paced.run("b", write("b1")),
    ];
    await Promise.all(writes);
    expect(log.map((entry) => entry.split("@")[0])).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("spends a burst, then waits for the budget to refill", async () => {
    const paced = pacer({ burst: 2, refillMs: 1000 });
    const writes = ["a", "b", "c", "d"].map((label) => paced.run(label, write(label)));
    await advance("3s");
    await Promise.all(writes);
    expect(log).toEqual(["a@0", "b@0", "c@1000", "d@2000"]);
  });

  it("drops a write cancelled before it starts, and finishes one already running", async () => {
    const paced = pacer({ conversationSpacingMs: 1000 });
    const running = new AbortController();
    const queued = new AbortController();
    const first = paced.run("a", write("1"), running.signal);
    const second = paced.run("a", write("2"), queued.signal);
    running.abort();
    queued.abort();
    await expect(first).resolves.toBe("1");
    await expect(second).rejects.toThrow();
    await advance("5s");
    expect(log).toEqual(["1@0"]);
  });

  it("holds every write of the account when the platform says to slow down", async () => {
    const paced = pacer();
    paced.pause(5000);
    const a = paced.run("a", write("a"));
    const b = paced.run("b", write("b"));
    await advance(0);
    expect(log).toEqual([]);
    await advance("6s");
    await Promise.all([a, b]);
    expect(log).toEqual(["a@5000", "b@5000"]);
  });

  it("keeps a pause the running write asked for", async () => {
    const paced = pacer();
    const limited = paced.run("a", async () => {
      paced.pause(3000);
      throw new Error("rate limited");
    });
    await expect(limited).rejects.toThrow();
    const next = paced.run("a", write("retry"));
    await advance("5s");
    await next;
    expect(log).toEqual(["retry@3000"]);
  });

  it("spaces a conversation's writes by what the budget names for that conversation", async () => {
    // A group allows fewer writes than a private chat, and its ids are negative.
    const paced = pacer({ conversationSpacingMs: (chat) => (chat.startsWith("-") ? 3000 : 1000) });
    const writes = [
      paced.run("-100", write("group 1")),
      paced.run("-100", write("group 2")),
      paced.run("7", write("private 1")),
      paced.run("7", write("private 2")),
    ];
    await advance("10s");
    await Promise.all(writes);
    expect(log).toEqual(["group 1@0", "private 1@0", "private 2@1000", "group 2@3000"]);
  });

  it("stops listening for an abort once a write starts, so a shared signal keeps no listener per write", async () => {
    const paced = pacer();
    const controller = new AbortController();
    for (let i = 0; i < 5; i++) await paced.run("a", write(String(i)), controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("forgets a conversation once its queue is empty and its spacing has passed", async () => {
    const paced = pacer({ conversationSpacingMs: 1000 });
    await Promise.all(["a", "b", "c"].map((label) => paced.run(label, write(label))));
    expect(paced.size).toBe(3);
    await advance("1s");
    expect(paced.size).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("rejects a write that throws before it returns, and keeps serving the account", async () => {
    const paced = pacer();
    const thrown = paced.run("a", () => {
      throw new Error("sync");
    });
    await expect(thrown).rejects.toThrow("sync");
    await expect(paced.run("b", write("next"))).resolves.toBe("next");
    expect(log).toEqual(["next@0"]);
  });

  it("gives back the budget and the spacing when a write chose not to write", async () => {
    // One token that never refills, and a second between writes to a conversation.
    const paced = pacer({ burst: 1, refillMs: 1_000_000, conversationSpacingMs: 1000 });
    await expect(paced.run("a", async () => SKIPPED)).resolves.toBe(SKIPPED);
    await expect(paced.run("a", write("real"))).resolves.toBe("real");
    expect(log).toEqual(["real@0"]);
  });

  it("rejects, instead of throwing, when its signal is already aborted", async () => {
    const paced = pacer();
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    let returned: Promise<string> | undefined;
    expect(() => {
      returned = paced.run("a", write("never"), controller.signal);
    }).not.toThrow();
    await expect(returned).rejects.toThrow("stopped");
    expect(log).toEqual([]);
  });

  it("stops a write that hangs from holding the queue, and still delivers its result", async () => {
    const paced = pacer();
    let finishSlow!: (value: string) => void;
    const slow = paced.run("a", () => new Promise<string>((resolve) => (finishSlow = resolve)));
    const other = paced.run("b", write("other"));
    await advance("29s");
    expect(log).toEqual([]);

    await advance("2s");
    await expect(other).resolves.toBe("other");
    expect(log).toEqual(["other@30000"]);

    // The hung write ends later. Its caller gets the result, and the queue
    // still serves a write that started after it was passed over.
    const later = paced.run("c", write("later"));
    finishSlow("late result");
    await expect(slow).resolves.toBe("late result");
    await advance(0);
    await expect(later).resolves.toBe("later");
  });

  it("counts a conversation's spacing from when its hung write really ended", async () => {
    const paced = pacer({ conversationSpacingMs: 5000 });
    let finishSlow!: () => void;
    const slow = paced.run(
      "a",
      () => new Promise<string>((resolve) => (finishSlow = () => resolve("slow"))),
    );
    const next = paced.run("a", write("a again"));
    // The watchdog fired at 30 s, and its spacing would have passed by 35 s.
    await advance("40s");
    finishSlow();
    await slow;
    await advance(0);

    // The platform may have handled the hung request just before it answered, so
    // the next write is not sent back to back with it.
    expect(log).toEqual([]);
    await advance("5s");
    await expect(next).resolves.toBe("a again");
    expect(log).toEqual(["a again@45000"]);
  });

  it("keeps a conversation's later writes behind a call its caller stopped waiting for, while other conversations go on", async () => {
    const paced = pacer();
    let end!: () => void;
    const call = new Promise<void>((resolve) => (end = resolve));
    const first = paced.run("a", async () => new Outlasted(call));
    const second = paced.run("a", write("a again"));
    const other = paced.run("b", write("b"));
    await advance(0);

    // The first caller has its answer, and the account went on to "b".
    await expect(first).resolves.toBeInstanceOf(Outlasted);
    expect(log).toEqual(["b@0"]);
    await other;

    end();
    await advance(0);
    await expect(second).resolves.toBe("a again");
    expect(log).toEqual(["b@0", "a again@0"]);
  });

  it("does not count a skipped write as a turn served, so its conversation keeps its place", async () => {
    const paced = pacer();
    // "a" is served first, then "b", so "a" has waited longest.
    await paced.run("a", write("a0"));
    await paced.run("b", write("b0"));
    const blocker = paced.run("c", async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    // "a" asks twice, the first of which is dropped, and "b" asks once.
    const dropped = paced.run("a", async () => SKIPPED);
    const aAgain = paced.run("a", write("a1"));
    const bAgain = paced.run("b", write("b1"));
    await blocker;
    await advance(0);
    await Promise.all([dropped, aAgain, bAgain]);

    // The dropped write wrote nothing, so "a" still goes before "b".
    expect(log).toEqual(["a0@0", "b0@0", "a1@0", "b1@0"]);
  });

  describe("a conversation held by a call that never ends", () => {
    it("gives the conversation back after a limit when the call its caller stopped waiting for never ends", async () => {
      const paced = pacer();
      await paced.run("a", async () => new Outlasted(new Promise<void>(() => {})));
      const next = paced.run("a", write("a again"));

      await advance("119s");
      expect(log).toEqual([]);
      await advance("2s");
      await expect(next).resolves.toBe("a again");
      expect(log).toEqual(["a again@120000"]);
    });

    it("gives the conversation back after a limit when a hung write never ends", async () => {
      const paced = pacer();
      void paced.run("a", () => new Promise<string>(() => {}));
      const next = paced.run("a", write("a again"));

      // The watchdog frees the account at 30 s, and the limit follows it.
      await advance("149s");
      expect(log).toEqual([]);
      await advance("2s");
      await expect(next).resolves.toBe("a again");
      expect(log).toEqual(["a again@150000"]);
    });

    it("does not let a call that ends after the limit free a conversation that has gone on", async () => {
      const paced = pacer();
      let endFirst!: () => void;
      await paced.run(
        "a",
        async () => new Outlasted(new Promise<void>((resolve) => (endFirst = resolve))),
      );
      let finishSecond!: () => void;
      const second = paced.run(
        "a",
        () => new Promise<string>((resolve) => (finishSecond = () => resolve("second"))),
      );
      const third = paced.run("a", write("third"));
      // The limit gave the conversation back, so the second write runs.
      await advance("121s");

      // The first call ends late, while the second still runs. The third keeps waiting.
      endFirst();
      await advance(0);
      expect(log).toEqual([]);

      finishSecond();
      await advance(0);
      await expect(second).resolves.toBe("second");
      await expect(third).resolves.toBe("third");
    });
  });

  it("keeps a conversation's later writes behind its hung write, while other conversations go on", async () => {
    const paced = pacer();
    let finishSlow!: () => void;
    const slow = paced.run(
      "a",
      () => new Promise<string>((resolve) => (finishSlow = () => resolve("slow"))),
    );
    const sameConversation = paced.run("a", write("a again"));
    const other = paced.run("b", write("b"));
    await advance("31s");

    // The account's queue moved on to "b". "a" is still inside its first write, so its second waits.
    expect(log).toEqual(["b@30000"]);
    await other;

    finishSlow();
    await slow;
    await advance(0);
    await expect(sameConversation).resolves.toBe("a again");
    expect(log).toEqual(["b@30000", "a again@31000"]);
  });

  it("does not let a passed-over write release the write that replaced it", async () => {
    const paced = pacer();
    let finishSlow!: () => void;
    void paced.run("a", () => new Promise<void>((resolve) => (finishSlow = resolve)));
    let finishSecond!: () => void;
    const second = paced.run("b", () => new Promise<void>((resolve) => (finishSecond = resolve)));
    const third = paced.run("c", write("third"));
    await advance("31s");
    // `b` replaced the hung `a` and is running. When `a` ends, `c` still waits.
    finishSlow();
    await advance(0);
    expect(log).toEqual([]);

    finishSecond();
    await second;
    await advance(0);
    await expect(third).resolves.toBe("third");
  });

  it("keeps going after a write fails", async () => {
    const paced = pacer();
    const failed = paced.run("a", async () => {
      throw new Error("refused");
    });
    await expect(failed).rejects.toThrow("refused");
    await expect(paced.run("a", write("next"))).resolves.toBe("next");
  });
});
