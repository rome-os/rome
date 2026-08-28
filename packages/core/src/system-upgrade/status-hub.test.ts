import { describe, it, expect, rs } from "@rstest/core";
import { UpgradeStatusHub } from "./status-hub.js";

/** Deterministic clock + timer wheel for the hub's countdown. */
class FakeClock {
  current = 1_000;
  private timers: { id: number; fireAt: number; fn: () => void }[] = [];
  private nextId = 1;

  now = (): number => this.current;
  setTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.push({ id, fireAt: this.current + ms, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers = this.timers.filter((t) => t.id !== (handle as unknown as number));
  };
  advance(ms: number): void {
    this.current += ms;
    const due = this.timers.filter((t) => t.fireAt <= this.current);
    this.timers = this.timers.filter((t) => t.fireAt > this.current);
    for (const t of due) t.fn();
  }
}

function makeHub(onDeadline = rs.fn()) {
  const clock = new FakeClock();
  const hub = new UpgradeStatusHub({
    onDeadline,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { hub, clock, onDeadline };
}

describe("UpgradeStatusHub", () => {
  it("starts idle", () => {
    const { hub } = makeHub();
    expect(hub.getSnapshot().phase).toBe("idle");
    expect(hub.getSnapshot().targetVersion).toBeNull();
  });

  it("beginCountdown moves to countdown with a deadline", () => {
    const { hub, clock } = makeHub();

    const started = hub.beginCountdown("1.2.3", 600_000);
    expect(started).toBe(true);

    const snap = hub.getSnapshot();
    expect(snap.phase).toBe("countdown");
    expect(snap.targetVersion).toBe("1.2.3");
    expect(snap.deadline).toBe(clock.now() + 600_000);
  });

  it("is idempotent: a second beginCountdown while one is live no-ops", () => {
    const { hub } = makeHub();
    hub.beginCountdown("1.2.3", 600_000);
    const deadline = hub.getSnapshot().deadline;
    const started = hub.beginCountdown("1.2.4", 1_000);
    expect(started).toBe(false);
    expect(hub.getSnapshot().targetVersion).toBe("1.2.3");
    expect(hub.getSnapshot().deadline).toBe(deadline);
  });

  it("invokes onDeadline when the deadline elapses, staying in countdown until an outcome", () => {
    const { hub, clock, onDeadline } = makeHub();
    hub.beginCountdown("1.2.3", 600_000);
    clock.advance(600_000);
    expect(onDeadline).toHaveBeenCalledExactlyOnceWith("1.2.3");
    // The phase only moves when the cutover outcome is reported back.
    expect(hub.getSnapshot().phase).toBe("countdown");
  });

  it("markRestarting moves countdown to updating and is terminal", () => {
    const { hub, clock, onDeadline } = makeHub();
    hub.beginCountdown("1.2.3", 600_000);
    hub.markRestarting();

    const snap = hub.getSnapshot();
    expect(snap.phase).toBe("updating");
    expect(snap.targetVersion).toBe("1.2.3");
    expect(snap.deadline).toBeNull();

    // Nothing un-sets updating: verbs no-op and the old timer is dead.
    hub.defer();
    hub.standDown();
    clock.advance(600_000);
    expect(onDeadline).not.toHaveBeenCalled();
    expect(hub.getSnapshot().phase).toBe("updating");
  });

  it("standDown returns a countdown to idle so the next probe can re-offer", () => {
    const { hub } = makeHub();
    hub.beginCountdown("1.2.3", 600_000);
    hub.standDown();
    expect(hub.getSnapshot().phase).toBe("idle");
    expect(hub.getSnapshot().targetVersion).toBeNull();
    expect(hub.beginCountdown("1.2.4", 1_000)).toBe(true);
  });

  it("defer returns to idle and cancels the auto-proceed", () => {
    const { hub, clock, onDeadline } = makeHub();
    hub.beginCountdown("1.2.3", 600_000);
    hub.defer();
    expect(hub.getSnapshot().phase).toBe("idle");
    expect(hub.getSnapshot().targetVersion).toBeNull();
    // The timer must be torn down — advancing past the old deadline does nothing.
    clock.advance(600_000);
    expect(onDeadline).not.toHaveBeenCalled();
    expect(hub.getSnapshot().phase).toBe("idle");
  });

  it("defer / markRestarting / standDown are no-ops while idle", () => {
    const { hub, onDeadline } = makeHub();
    hub.defer();
    hub.markRestarting();
    hub.standDown();
    expect(hub.getSnapshot().phase).toBe("idle");
    expect(onDeadline).not.toHaveBeenCalled();
  });

  it("can re-offer after a defer", () => {
    const { hub } = makeHub();
    hub.beginCountdown("1.2.3", 600_000);
    hub.defer();
    const started = hub.beginCountdown("1.2.4", 1_000);
    expect(started).toBe(true);
    expect(hub.getSnapshot().targetVersion).toBe("1.2.4");
  });
});
