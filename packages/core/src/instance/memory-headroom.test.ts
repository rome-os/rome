import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { readMemoryHeadroom } from "./memory-headroom.js";

const GIB = 1024 ** 3;

describe("readMemoryHeadroom", () => {
  const roots: string[] = [];

  /** A fake `/sys/fs/cgroup` holding `files`, plus an optional fake `/proc/meminfo`. */
  function fakeHost(files: Record<string, string>, meminfo?: string) {
    const root = mkdtempSync(join(tmpdir(), "rome-cgroup-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const meminfoPath = join(root, "meminfo");
    if (meminfo !== undefined) writeFileSync(meminfoPath, meminfo);
    return { cgroupRoot: join(root, "cgroup"), meminfoPath };
  }

  function cgroupFiles(files: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(files).map(([k, v]) => [join("cgroup", k), v]));
  }

  const meminfo4g = `MemTotal:        4096000 kB\nMemFree:          102400 kB\nMemAvailable:    1024000 kB\nBuffers:           10240 kB\n`;

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reads a cgroup v2 limit and counts reclaimable file cache as free", () => {
    const { cgroupRoot, meminfoPath } = fakeHost(
      cgroupFiles({
        "memory.max": `${4 * GIB}\n`,
        "memory.current": `${3 * GIB}\n`,
        "memory.stat": `anon ${2 * GIB}\nfile ${GIB}\ninactive_file ${GIB / 2}\nactive_file ${GIB / 2}\n`,
      }),
    );

    expect(readMemoryHeadroom(cgroupRoot, meminfoPath)).toEqual({
      source: "cgroup-v2",
      limitBytes: 4 * GIB,
      availableBytes: 4 * GIB - (3 * GIB - GIB / 2),
    });
  });

  it("reads a cgroup v1 limit", () => {
    const { cgroupRoot, meminfoPath } = fakeHost(
      cgroupFiles({
        "memory/memory.limit_in_bytes": `${4 * GIB}\n`,
        "memory/memory.usage_in_bytes": `${2 * GIB}\n`,
        "memory/memory.stat": `total_inactive_file ${GIB}\ncache ${GIB}\n`,
      }),
    );

    expect(readMemoryHeadroom(cgroupRoot, meminfoPath)).toEqual({
      source: "cgroup-v1",
      limitBytes: 4 * GIB,
      availableBytes: 4 * GIB - (2 * GIB - GIB),
    });
  });

  it("prefers a cgroup limit that fits in the host's memory", () => {
    const { cgroupRoot, meminfoPath } = fakeHost(
      cgroupFiles({ "memory.max": `${2 * GIB}\n`, "memory.current": `${GIB}\n` }),
      meminfo4g,
    );

    expect(readMemoryHeadroom(cgroupRoot, meminfoPath)?.source).toBe("cgroup-v2");
  });

  it("uses the host's MemAvailable when the cgroup has no limit", () => {
    const { cgroupRoot, meminfoPath } = fakeHost(
      cgroupFiles({ "memory.max": "max\n", "memory.current": "1024\n" }),
      meminfo4g,
    );

    expect(readMemoryHeadroom(cgroupRoot, meminfoPath)).toEqual({
      source: "meminfo",
      limitBytes: 4_096_000 * 1024,
      availableBytes: 1_024_000 * 1024,
    });
  });

  it("uses the host's MemAvailable when the cgroup limit exceeds the host's memory", () => {
    const { cgroupRoot, meminfoPath } = fakeHost(
      cgroupFiles({ "memory.max": `${64 * GIB}\n`, "memory.current": "1024\n" }),
      meminfo4g,
    );

    expect(readMemoryHeadroom(cgroupRoot, meminfoPath)?.source).toBe("meminfo");
  });

  it("uses the host's MemAvailable when a cgroup v1 limit is the unlimited sentinel", () => {
    const { cgroupRoot, meminfoPath } = fakeHost(
      cgroupFiles({
        "memory/memory.limit_in_bytes": "9223372036854771712\n",
        "memory/memory.usage_in_bytes": "1024\n",
      }),
      meminfo4g,
    );

    expect(readMemoryHeadroom(cgroupRoot, meminfoPath)?.source).toBe("meminfo");
  });

  it("reports nothing where neither a cgroup limit nor /proc/meminfo exists", () => {
    const { cgroupRoot, meminfoPath } = fakeHost(
      cgroupFiles({ "memory.max": "max\n", "memory.current": "1024\n" }),
    );

    expect(readMemoryHeadroom(cgroupRoot, meminfoPath)).toBeNull();
    expect(readMemoryHeadroom(join(cgroupRoot, "missing"), meminfoPath)).toBeNull();
  });

  it("never reports negative headroom", () => {
    const { cgroupRoot, meminfoPath } = fakeHost(
      cgroupFiles({
        "memory.max": "1024\n",
        "memory.current": "4096\n",
        "memory.stat": "inactive_file 0\n",
      }),
    );

    expect(readMemoryHeadroom(cgroupRoot, meminfoPath)?.availableBytes).toBe(0);
  });
});
