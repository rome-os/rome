import { describe, expect, it } from "@rstest/core";
import { readResourceReadings } from "./resource-readings.js";

const GIB = 1024 ** 3;

describe("readResourceReadings", () => {
  it("passes healthy readings through unmarked", () => {
    const readings = readResourceReadings({
      memory: () => ({ source: "meminfo", limitBytes: 4 * GIB, availableBytes: 2.6 * GIB }),
      disk: () => ({ path: "/data", totalBytes: 40 * GIB, freeBytes: 21 * GIB }),
    });

    expect(readings).toEqual({
      memory: { limitBytes: 4 * GIB, availableBytes: 2.6 * GIB, short: false },
      disk: { totalBytes: 40 * GIB, freeBytes: 21 * GIB, low: false },
    });
  });

  it("marks memory short and disk low on the same lines the engine uses", () => {
    const readings = readResourceReadings({
      // 14% available: under the 15% line that holds queued work.
      memory: () => ({ source: "cgroup-v2", limitBytes: 4 * GIB, availableBytes: 0.56 * GIB }),
      // 9% free: under the 10% line.
      disk: () => ({ path: "/data", totalBytes: 40 * GIB, freeBytes: 3.6 * GIB }),
    });

    expect(readings.memory?.short).toBe(true);
    expect(readings.disk?.low).toBe(true);
  });

  it("leaves a reading null where the host offers none", () => {
    const readings = readResourceReadings({ memory: () => null, disk: () => null });

    expect(readings).toEqual({ memory: null, disk: null });
  });
});
