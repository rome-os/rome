import { describe, expect, it } from "@rstest/core";
import { defaultWorkerCap } from "./worker-cap.js";

const GIB = 1024 ** 3;

describe("defaultWorkerCap", () => {
  it("gives the smallest plan about six workers", () => {
    expect(defaultWorkerCap(4 * GIB)).toBe(6);
  });

  it("scales with memory and stops at sixteen", () => {
    expect(defaultWorkerCap(8 * GIB)).toBe(12);
    expect(defaultWorkerCap(16 * GIB)).toBe(16);
    expect(defaultWorkerCap(64 * GIB)).toBe(16);
  });

  it("never drops under four, so queued roots keep slots beside the reserved two", () => {
    expect(defaultWorkerCap(1 * GIB)).toBe(4);
    expect(defaultWorkerCap(2 * GIB)).toBe(4);
  });

  it("keeps the old fixed cap when memory is unknown", () => {
    expect(defaultWorkerCap(null)).toBe(8);
    expect(defaultWorkerCap(undefined)).toBe(8);
    expect(defaultWorkerCap(0)).toBe(8);
    expect(defaultWorkerCap(Number.NaN)).toBe(8);
  });
});
