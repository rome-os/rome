import { describe, expect, it } from "@rstest/core";
import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_MAX_WORKERS,
  DEFAULT_WORKER_AGENT,
  normalizeIntervalMinutes,
  parseConfig,
  reconcileTrigger,
} from "./config.js";

describe("parseConfig", () => {
  it("rejects a working directory that is not absolute", () => {
    const parsed = parseConfig({ workingDir: "project" });
    expect(parsed.ok).toBe(false);
  });

  it("fills in every cap the caller left out", () => {
    const parsed = parseConfig({ workingDir: "/srv/project" });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.config.workerAgent).toBe(DEFAULT_WORKER_AGENT);
    expect(parsed.config.maxWorkers).toBe(DEFAULT_MAX_WORKERS);
    expect(parsed.config.intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
  });

  it("degrades a nonsense cap to its default rather than failing", () => {
    const parsed = parseConfig({ workingDir: "/srv/project", maxWorkers: -4, startCap: "many" });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.config.maxWorkers).toBe(DEFAULT_MAX_WORKERS);
    expect(parsed.config.startCap).toBe(2);
  });
});

describe("normalizeIntervalMinutes", () => {
  it("snaps to a cadence the cron conversion reproduces exactly", () => {
    expect(normalizeIntervalMinutes(5)).toBe(5);
    expect(normalizeIntervalMinutes(7)).toBe(6);
    expect(normalizeIntervalMinutes(45)).toBe(30);
    expect(normalizeIntervalMinutes(0)).toBe(DEFAULT_INTERVAL_MINUTES);
  });
});

describe("reconcileTrigger", () => {
  it("builds a MINUTELY rule the scheduler accepts", () => {
    expect(reconcileTrigger(5)).toEqual({
      type: "schedule",
      tzid: "UTC",
      tzMode: "floating",
      localTime: "00:00",
      rrule: "FREQ=MINUTELY;INTERVAL=5",
    });
  });
});
