import { getEventListeners } from "node:events";
import { beforeEach, describe, expect, it } from "@rstest/core";
import { FakeClock } from "../../test/kit/clock.js";
import { type Budget, Pacer } from "./pacer.js";

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

  it("keeps going after a write fails", async () => {
    const paced = pacer();
    const failed = paced.run("a", async () => {
      throw new Error("refused");
    });
    await expect(failed).rejects.toThrow("refused");
    await expect(paced.run("a", write("next"))).resolves.toBe("next");
  });
});
