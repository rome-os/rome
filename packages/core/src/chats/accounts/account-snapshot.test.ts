import { describe, it, expect } from "@rstest/core";
import { sharedRead } from "./account-snapshot.js";

describe("sharedRead", () => {
  /** A read that only settles when the test says so. */
  function gated() {
    let calls = 0;
    let release: (value: number) => void = () => {};
    const read = sharedRead(() => {
      calls += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    });
    return { read, release: (value: number) => release(value), calls: () => calls };
  }

  it("serves callers that overlap from one read", async () => {
    const { read, release, calls } = gated();

    const both = Promise.all([read(), read()]);
    release(7);

    expect(await both).toEqual([7, 7]);
    expect(calls()).toBe(1);
  });

  it("reads again once the shared one has settled — this is not a cache", async () => {
    const { read, release, calls } = gated();

    const first = read();
    release(1);
    expect(await first).toBe(1);

    const second = read();
    release(2);
    expect(await second).toBe(2);
    expect(calls()).toBe(2);
  });

  it("does not hold a failed read for the next caller", async () => {
    let calls = 0;
    const read = sharedRead(async () => {
      calls += 1;
      if (calls === 1) throw new Error("mirror unavailable");
      return "ok";
    });

    await expect(read()).rejects.toThrow("mirror unavailable");
    await expect(read()).resolves.toBe("ok");
  });
});
