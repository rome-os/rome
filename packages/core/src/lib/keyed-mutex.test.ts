import { describe, expect, it } from "@rstest/core";
import { KeyedMutex } from "./keyed-mutex.js";

/** A promise plus its resolver, for driving deterministic interleavings. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("KeyedMutex", () => {
  it("serializes work for the same key in submission (FIFO) order", async () => {
    const km = new KeyedMutex();
    const order: string[] = [];
    const first = deferred();

    const a = km.runExclusive("k", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = km.runExclusive("k", async () => {
      order.push("b");
    });

    // b must not start until a finishes, even though it was submitted while a ran.
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  it("runs work for different keys concurrently", async () => {
    const km = new KeyedMutex();
    const order: string[] = [];
    const release = deferred();

    const x = km.runExclusive("x", async () => {
      order.push("x:start");
      await release.promise;
      order.push("x:end");
    });
    const y = km.runExclusive("y", async () => {
      order.push("y");
    });

    // y is a different key, so it runs without waiting for x.
    await y;
    expect(order).toEqual(["x:start", "y"]);
    release.resolve();
    await x;
    expect(order).toEqual(["x:start", "y", "x:end"]);
  });

  it("returns the callback's result to its caller", async () => {
    const km = new KeyedMutex();
    await expect(km.runExclusive("k", async () => 42)).resolves.toBe(42);
    await expect(km.runExclusive("k", () => "sync")).resolves.toBe("sync");
  });

  it("propagates a rejection to the caller without blocking later work", async () => {
    const km = new KeyedMutex();
    const failed = km.runExclusive("k", async () => {
      throw new Error("boom");
    });
    const recovered = km.runExclusive("k", async () => "ok");

    await expect(failed).rejects.toThrow("boom");
    await expect(recovered).resolves.toBe("ok");
  });

  it("evicts a key once its work drains (map does not leak)", async () => {
    const km = new KeyedMutex();
    expect(km.size).toBe(0);

    await km.runExclusive("k", async () => {});
    expect(km.size).toBe(0);

    // A rejected task must also evict.
    await km
      .runExclusive("k", async () => {
        throw new Error("x");
      })
      .catch(() => {});
    expect(km.size).toBe(0);
  });

  it("keeps one entry while multiple waiters are queued, then evicts", async () => {
    const km = new KeyedMutex();
    const gate = deferred();

    const a = km.runExclusive("k", () => gate.promise);
    const b = km.runExclusive("k", async () => {});
    // Both waiters share a single entry for the key.
    expect(km.size).toBe(1);

    gate.resolve();
    await Promise.all([a, b]);
    expect(km.size).toBe(0);
  });

  it("reports isLocked while a key is running and false once idle", async () => {
    const km = new KeyedMutex();
    const gate = deferred();

    expect(km.isLocked("k")).toBe(false);
    const run = km.runExclusive("k", () => gate.promise);
    expect(km.isLocked("k")).toBe(true);
    expect(km.isLocked("other")).toBe(false);

    gate.resolve();
    await run;
    expect(km.isLocked("k")).toBe(false);
  });

  it("serializes a fresh acquirer that arrives after a key was evicted", async () => {
    const km = new KeyedMutex();
    const order: string[] = [];

    await km.runExclusive("k", async () => {
      order.push("first");
    });
    expect(km.size).toBe(0); // evicted — next call builds a new entry

    const gate = deferred();
    const a = km.runExclusive("k", async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:end");
    });
    const b = km.runExclusive("k", async () => {
      order.push("b");
    });
    await Promise.resolve();
    expect(order).toEqual(["first", "a:start"]); // b still queued behind a
    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["first", "a:start", "a:end", "b"]);
  });

  it("interleaves many keys under concurrent load while serializing each", async () => {
    const km = new KeyedMutex();
    const perKey: Record<string, number[]> = { a: [], b: [], c: [] };
    const running: Record<string, boolean> = { a: false, b: false, c: false };
    let overlap = false;

    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      const key = (["a", "b", "c"] as const)[i % 3];
      tasks.push(
        km.runExclusive(key, async () => {
          // Detect any concurrent run for the same key.
          if (running[key]) overlap = true;
          running[key] = true;
          await Promise.resolve();
          perKey[key].push(i);
          running[key] = false;
        }),
      );
    }
    await Promise.all(tasks);

    expect(overlap).toBe(false); // never two runs for one key at once
    expect(perKey.a).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27]); // FIFO per key
    expect(perKey.b).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28]);
    expect(perKey.c).toEqual([2, 5, 8, 11, 14, 17, 20, 23, 26, 29]);
    expect(km.size).toBe(0); // all keys evicted
  });
});
