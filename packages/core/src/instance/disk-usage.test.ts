import { describe, expect, it } from "@rstest/core";
import { readDiskUsage } from "./disk-usage.js";

const GIB = 1024 ** 3;

describe("readDiskUsage", () => {
  it("reports the volume's total and the space an unprivileged writer can use", () => {
    const usage = readDiskUsage("/data", () => ({
      bsize: 4096,
      blocks: (40 * GIB) / 4096,
      bavail: (21 * GIB) / 4096,
    }));

    expect(usage).toEqual({ path: "/data", totalBytes: 40 * GIB, freeBytes: 21 * GIB });
  });

  it("returns null when the volume cannot be read", () => {
    expect(
      readDiskUsage("/missing", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });

  it("returns null for a volume that reports no blocks", () => {
    expect(readDiskUsage("/proc", () => ({ bsize: 4096, blocks: 0, bavail: 0 }))).toBeNull();
  });

  it("clamps free space into the volume's bounds", () => {
    const usage = readDiskUsage("/data", () => ({ bsize: 1, blocks: 100, bavail: 250 }));

    expect(usage?.freeBytes).toBe(100);
  });
});
