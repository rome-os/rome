import { describe, expect, it } from "@rstest/core";
import { containerUptimeMs } from "./runtime.js";

function procReader(files: Record<string, string>) {
  return (path: string): string => {
    const content = files[path];
    if (content === undefined)
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return content;
  };
}

describe("containerUptimeMs", () => {
  it("measures from PID 1's start, even when its command name contains spaces", () => {
    // PID 1 started 1000 ticks (10 s) after boot; the system has been up 25.5 s.
    const stat = `1 (s6 svscan x) S 0 1 1 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 1000 1234 56`;
    const read = procReader({ "/proc/uptime": "25.50 40.00\n", "/proc/1/stat": stat });

    expect(containerUptimeMs(read)).toBe(15_500);
  });

  it("returns null when /proc is unavailable", () => {
    expect(containerUptimeMs(procReader({}))).toBeNull();
  });
});
