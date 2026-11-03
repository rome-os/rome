import { describe, expect, it } from "@rstest/core";
import { commandText, platformOf, resultOf, summarize } from "./format.js";
import type { NodeActionRow } from "./protocol.js";
import { failureRate, statsByPeer, windowStart, BUCKET_MS, BUCKETS } from "./stats.js";

function row(fields: Partial<NodeActionRow> = {}): NodeActionRow {
  return {
    id: 1,
    direction: "out",
    peer: "dev-1",
    action: "exec",
    mode: "json",
    command: "git",
    args: ["status"],
    cwd: null,
    startedAt: 0,
    endedAt: 10,
    outcome: "ok",
    errorCode: null,
    exitCode: 0,
    signal: null,
    stdinBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    transfer: null,
    ...fields,
  };
}

describe("resultOf", () => {
  it("matches the daemon's result rule", () => {
    expect(resultOf(row({ endedAt: null, outcome: null }))).toBe("running");
    expect(resultOf(row())).toBe("succeeded");
    expect(resultOf(row({ exitCode: null }))).toBe("succeeded");
    expect(resultOf(row({ exitCode: 2 }))).toBe("failed");
    expect(resultOf(row({ exitCode: null, signal: "SIGKILL" }))).toBe("failed");
    expect(resultOf(row({ outcome: "error", exitCode: null }))).toBe("failed");
    for (const outcome of ["unknown_outcome", "aborted", "interrupted"] as const)
      expect(resultOf(row({ outcome, exitCode: null }))).toBe("no_result");
  });
});

describe("summarize", () => {
  it("joins a script's lines and quotes an argv", () => {
    const script = row({ command: "/bin/bash", args: ["-lc", "set -e\n cd ~/rome\npnpm test"] });
    expect(summarize(script)).toBe("set -e; cd ~/rome; pnpm test");
    expect(commandText(script)).toBe("set -e\n cd ~/rome\npnpm test");
    expect(summarize(row({ command: "open", args: ["-a", "Google Chrome"] }))).toBe(
      'open -a "Google Chrome"',
    );
    expect(
      summarize(
        row({
          command: null,
          args: null,
          transfer: {
            direction: "pull",
            localPath: "/a",
            remotePath: "/b",
            bytes: 1,
            sha256: null,
          },
        }),
      ),
    ).toBe("/b → /a");
  });
});

describe("platformOf", () => {
  it("names common platforms and keeps others as given", () => {
    expect(platformOf("darwin")).toEqual({ kind: "laptop", label: "macOS" });
    expect(platformOf("win32")).toEqual({ kind: "desktop", label: "Windows" });
    expect(platformOf("linux")).toEqual({ kind: "server", label: "Linux" });
    expect(platformOf("freebsd")).toEqual({ kind: "server", label: "freebsd" });
    expect(platformOf(null)).toEqual({ kind: "server", label: null });
  });
});

describe("statsByPeer", () => {
  it("folds groups into per-peer buckets, totals, and the peak", () => {
    const since = windowStart(Date.UTC(2026, 9, 15, 12, 34));
    expect(since % BUCKET_MS).toBe(0);
    expect(Date.UTC(2026, 9, 15, 12, 34) - since).toBeLessThan(BUCKETS * BUCKET_MS);
    const stats = statsByPeer({
      since,
      until: since + BUCKETS * BUCKET_MS,
      bucketMs: BUCKET_MS,
      groups: [
        { peer: "DEV-1", bucket: 0, result: "succeeded", count: 3 },
        { peer: "DEV-1", bucket: 0, result: "failed", count: 1 },
        { peer: "DEV-1", bucket: 5, result: "running", count: 1 },
        { peer: "dev-2", bucket: 1, result: "no_result", count: 2 },
      ],
    });
    const device = stats.get("dev-1")!;
    expect(device.buckets).toHaveLength(BUCKETS);
    expect(device.counts).toEqual({ all: 5, running: 1, succeeded: 3, failed: 1, no_result: 0 });
    expect(device.peak?.start).toBe(since);
    expect(failureRate(device.counts)).toBe(0.25);
    expect(stats.get("dev-2")!.buckets[1]!.counts.no_result).toBe(2);
    expect(failureRate({ all: 1, running: 1, succeeded: 0, failed: 0, no_result: 0 })).toBeNull();
  });
});
