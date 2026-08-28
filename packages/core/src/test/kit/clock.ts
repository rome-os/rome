import { rs } from "@rstest/core";
import type { Clock, ClockTimer } from "../../lib/clock.js";

// Wall-clock time is a process edge; tests control it instead of sleeping.
// Two tools, by mechanism:
//
// - FakeClock — implements the production `Clock` seam. Inject it into a
//   component that takes a Clock (ActionEngine, RoutineEngine) and drive
//   that component's time with advance(). Never touches global timers, so
//   it composes with real-time machinery (croner, chokidar, network fakes)
//   running in the same test.
// - installTestClock — thin wrapper over Rstest's *global* fake timers, for
//   code that still reads ambient time. Standardizes the install /
//   advance-with-microtask-flush / restore dance.
//
// Don't mix them in one test: FakeClock.advance() settles fired work via
// setImmediate, which global fake timers would stall.
// Both accept human durations ("5m") so timing tests read as scenarios.

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse `150`, `"150ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"` into milliseconds. */
export function parseDuration(input: number | string): number {
  if (typeof input === "number") {
    return input;
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(input.trim());
  if (!match) {
    throw new Error(`Unparseable duration "${input}" — use e.g. 1500, "1500ms", "30s", "5m", "2h"`);
  }
  return Number(match[1]) * UNIT_MS[match[2]];
}

export interface TestClock {
  now(): Date;
  /** Advance fake time, running due timers and flushing microtasks. */
  advance(duration: number | string): Promise<void>;
  /** Run all currently-pending timers without advancing past them. */
  runUntilIdle(): Promise<void>;
  /** Restore real timers. Always call in afterEach/cleanup. */
  uninstall(): void;
}

export function installTestClock(start?: Date): TestClock {
  rs.useFakeTimers(start ? { now: start } : undefined);
  return {
    now: () => new Date(),
    advance: async (duration) => {
      await rs.advanceTimersByTimeAsync(parseDuration(duration));
    },
    runUntilIdle: async () => {
      await rs.runOnlyPendingTimersAsync();
    },
    uninstall: () => {
      rs.useRealTimers();
    },
  };
}

interface ScheduledTimer {
  at: number;
  seq: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  private nowMs: number;
  private seq = 0;
  private readonly timers = new Map<ClockTimer, ScheduledTimer>();

  constructor(start: Date = new Date("2026-01-01T00:00:00Z")) {
    this.nowMs = start.getTime();
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  setTimeout(fn: () => void, delayMs: number): ClockTimer {
    const handle: ClockTimer = {};
    this.timers.set(handle, { at: this.nowMs + delayMs, seq: this.seq++, fn });
    return handle;
  }

  clearTimeout(timer: ClockTimer): void {
    this.timers.delete(timer);
  }

  /** Timers scheduled and not yet fired or cleared. */
  pendingTimerCount(): number {
    return this.timers.size;
  }

  /**
   * Advance fake time, firing due timers in schedule order. Async work each
   * timer kicks off is settled before the next timer fires (and before
   * advance() resolves), so post-advance assertions see the timer's full
   * fallout. Timers a callback schedules within the window also fire.
   */
  async advance(duration: number | string): Promise<void> {
    const target = this.nowMs + parseDuration(duration);
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, a], [, b]) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.timers.delete(handle);
      this.nowMs = Math.max(this.nowMs, timer.at);
      timer.fn();
      await flushAsyncWork();
    }
    this.nowMs = target;
  }
}

/** Let promise chains started by a fired timer settle: setImmediate runs
 * after the microtask queue drains; two rounds cover chains that hop through
 * an I/O callback (e.g. a DB write inside a routine retry). */
async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
