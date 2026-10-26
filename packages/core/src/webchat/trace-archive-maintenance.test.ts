import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  canVacuumTraces,
  startTraceArchiveMaintenance,
  type VacuumGuards,
} from "./trace-archive-maintenance.js";
import type { TraceArchiver } from "./trace-archive.js";
const GiB = 1024 ** 3;
const valid: VacuumGuards = {
  pageSize: 4096,
  pageCount: (2 * GiB) / 4096,
  freelist: GiB / 4096,
  freeDisk: 3 * GiB,
  now: new Date("2026-10-25T03:00:00Z"),
  timezone: "UTC",
  turnRunning: false,
  lastActivityAt: Date.parse("2026-10-25T02:30:00Z"),
  routineDue: false,
};
afterEach(() => {
  rs.useRealTimers();
});
describe("quiet-window vacuum", () => {
  it("allows the exact byte and inactivity boundaries", () => {
    expect(canVacuumTraces(valid)).toBe(true);
  });
  for (const [name, changes] of Object.entries({
    "less than 1 GiB free": { freelist: valid.freelist - 1 },
    "less than 25% free": { pageCount: valid.freelist * 4 + 1, freeDisk: 10 * GiB },
    "before 02:00": { now: new Date("2026-10-25T01:59:59Z") },
    "at 06:00": { now: new Date("2026-10-25T06:00:00Z") },
    "guardian timezone": { timezone: "America/Los_Angeles" },
    "a running turn": { turnRunning: true },
    "recent conversation": { lastActivityAt: valid.now.getTime() - 30 * 60_000 + 1 },
    "routine due": { routineDue: true },
    "not enough disk": { freeDisk: 3 * GiB - 1 },
  })) {
    it(`skips when ${name}`, () => {
      expect(canVacuumTraces({ ...valid, ...changes })).toBe(false);
    });
  }
  it("delays archiving 10 minutes, repeats daily, checks quiet time hourly, and cancels timers", async () => {
    rs.useFakeTimers();
    const runPass = rs.fn(async () => ({}));
    const vacuum = rs.fn(async () => {});
    const stop = rs.fn(async () => {});
    const cancel = startTraceArchiveMaintenance({
      archiver: { runPass, stop } as unknown as TraceArchiver,
      vacuum,
    });
    expect(runPass).not.toHaveBeenCalled();
    expect(vacuum).not.toHaveBeenCalled();
    await rs.advanceTimersByTimeAsync(10 * 60_000);
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(vacuum).not.toHaveBeenCalled();
    await rs.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(vacuum).toHaveBeenCalledTimes(24);
    await cancel();
    await rs.advanceTimersByTimeAsync(48 * 60 * 60_000);
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(vacuum).toHaveBeenCalledTimes(24);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
