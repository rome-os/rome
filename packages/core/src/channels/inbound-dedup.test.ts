import { describe, expect, it } from "@rstest/core";
import { InboundDedup } from "./inbound-dedup.js";

describe("InboundDedup", () => {
  it("reports a key as new the first time and a duplicate thereafter", () => {
    const dedup = new InboundDedup();
    expect(dedup.checkAndRecord("msg_1")).toBe(false);
    expect(dedup.checkAndRecord("msg_1")).toBe(true);
    expect(dedup.checkAndRecord("msg_1")).toBe(true);
  });

  it("tracks distinct keys independently", () => {
    const dedup = new InboundDedup();
    expect(dedup.checkAndRecord("a")).toBe(false);
    expect(dedup.checkAndRecord("b")).toBe(false);
    expect(dedup.checkAndRecord("a")).toBe(true);
    expect(dedup.checkAndRecord("b")).toBe(true);
  });

  it("evicts the oldest key once capacity is exceeded (FIFO)", () => {
    const dedup = new InboundDedup(2);
    dedup.checkAndRecord("a"); // [a]
    dedup.checkAndRecord("b"); // [a, b]
    dedup.checkAndRecord("c"); // overflow → evict a → [b, c]

    // "a" was evicted, so it reads as new again; "b"/"c" still seen.
    expect(dedup.checkAndRecord("a")).toBe(false);
    expect(dedup.checkAndRecord("c")).toBe(true);
  });
});
