import { describe, expect, it } from "@rstest/core";
import { InMemoryInboundDedup } from "./inbound-dedup.js";

describe("InMemoryInboundDedup", () => {
  it("reports a key as new the first time and a duplicate thereafter", async () => {
    const dedup = new InMemoryInboundDedup();
    expect(await dedup.checkAndRecord("msg_1")).toBe(false);
    expect(await dedup.checkAndRecord("msg_1")).toBe(true);
    expect(await dedup.checkAndRecord("msg_1")).toBe(true);
  });

  it("tracks distinct keys independently", async () => {
    const dedup = new InMemoryInboundDedup();
    expect(await dedup.checkAndRecord("a")).toBe(false);
    expect(await dedup.checkAndRecord("b")).toBe(false);
    expect(await dedup.checkAndRecord("a")).toBe(true);
    expect(await dedup.checkAndRecord("b")).toBe(true);
  });

  it("evicts the oldest key once capacity is exceeded (FIFO)", async () => {
    const dedup = new InMemoryInboundDedup(2);
    await dedup.checkAndRecord("a"); // [a]
    await dedup.checkAndRecord("b"); // [a, b]
    await dedup.checkAndRecord("c"); // overflow → evict a → [b, c]

    // "a" was evicted, so it reads as new again; "b"/"c" still seen.
    expect(await dedup.checkAndRecord("a")).toBe(false);
    expect(await dedup.checkAndRecord("c")).toBe(true);
  });
});
