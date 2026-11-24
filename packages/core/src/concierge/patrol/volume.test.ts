import { describe, expect, it } from "@rstest/core";
import {
  COOLDOWN_MS,
  DAY_MS,
  HOUR_MS,
  changedMaterially,
  holdReason,
  type HoldFacts,
  mayRaise,
  nearDigest,
  patrolQuietUntil,
  restGap,
  settleOutcome,
} from "./volume.js";

const zone = "Asia/Shanghai";
/** 2026-11-23 at `hh:mm` in Shanghai. */
const at = (hhmm: string) => Date.parse(`2026-11-23T${hhmm}:00+08:00`);

const facts = (change: Partial<HoldFacts> = {}): HoldFacts => ({
  now: at("12:45"),
  timeZone: zone,
  quietHours: null,
  digestTimes: ["09:00", "18:00"],
  toldToday: 0,
  lastRunAt: null,
  lastOwnerMessageAt: at("11:00"),
  intervalMs: 3 * HOUR_MS,
  recheck: false,
  ...change,
});

const observation = (change: Partial<Parameters<typeof mayRaise>[0]> = {}) => ({
  status: "open" as const,
  basis: "observed" as const,
  confidence: 0.9,
  outcomes: [],
  lastToldAt: null,
  ignoredCount: 0,
  dueAt: null,
  ...change,
});

describe("when the patrol holds", () => {
  it("keeps the owner's quiet hours, and its own night when they set none", () => {
    expect(patrolQuietUntil(at("23:30"), null, zone)).toBe(at("08:00") + DAY_MS);
    expect(patrolQuietUntil(at("12:00"), null, zone)).toBeNull();
    expect(patrolQuietUntil(at("23:30"), { start: "01:00", end: "06:00" }, zone)).toBeNull();
    expect(holdReason(facts({ now: at("03:45") }))).toBe("quiet_hours");
  });

  it("counts every proactive message of the day against the cap of three", () => {
    expect(holdReason(facts({ toldToday: 2 }))).toBeNull();
    expect(holdReason(facts({ toldToday: 3 }))).toBe("daily_cap");
  });

  it("says nothing within half an hour of a digest time, either side, in the owner's zone", () => {
    expect(nearDigest(at("08:31"), ["09:00"], zone)).toBe(true);
    expect(nearDigest(at("09:30"), ["09:00"], zone)).toBe(true);
    expect(nearDigest(at("09:45"), ["09:00"], zone)).toBe(false);
    // Across midnight.
    expect(nearDigest(at("23:50"), ["00:10"], zone)).toBe(true);
    expect(holdReason(facts({ now: at("17:45") }))).toBe("near_digest");
  });

  it("slows down while the owner is away, and a wake-up it set itself is never held for it", () => {
    const interval = 3 * HOUR_MS;
    expect(restGap(at("11:00"), at("12:45"), interval)).toBe(0);
    expect(restGap(at("11:00") - 2 * DAY_MS, at("12:45"), interval)).toBeGreaterThan(interval);
    expect(restGap(null, at("12:45"), interval)).toBeGreaterThan(20 * HOUR_MS);
    const away = facts({ lastOwnerMessageAt: at("11:00") - 5 * DAY_MS, lastRunAt: at("09:45") });
    expect(holdReason(away)).toBe("resting");
    expect(holdReason({ ...away, recheck: true })).toBeNull();
  });
});

describe("the cooldown of a topic", () => {
  const now = at("12:45");

  it("never tells an inferred observation, one that is not open, or a weak one", () => {
    expect(mayRaise(observation(), now)).toEqual({ ok: true });
    expect(mayRaise(observation({ basis: "inferred" }), now)).toEqual({
      ok: false,
      reason: "inferred",
    });
    expect(mayRaise(observation({ status: "done" }), now)).toMatchObject({ ok: false });
    expect(mayRaise(observation({ confidence: 0.4 }), now)).toMatchObject({
      reason: "low_confidence",
    });
  });

  it("does not raise a told topic again for three days", () => {
    const told = observation({ lastToldAt: new Date(now - 2 * DAY_MS) });
    expect(mayRaise(told, now)).toEqual({ ok: false, reason: "cooldown" });
    expect(mayRaise(told, now - 2 * DAY_MS + COOLDOWN_MS + 1)).toEqual({ ok: true });
  });

  it("raises it before then when it changed materially: a deadline came near, or its task moved", () => {
    const toldAt = new Date(now - DAY_MS);
    const nearing = observation({ lastToldAt: toldAt, dueAt: new Date(now + 6 * HOUR_MS) });
    expect(mayRaise(nearing, now)).toEqual({ ok: true });
    // A due time that was already near when it was told brings nothing new.
    const stillNear = observation({
      lastToldAt: new Date(now - HOUR_MS),
      dueAt: new Date(now + 6 * HOUR_MS),
    });
    expect(mayRaise(stillNear, now)).toEqual({ ok: false, reason: "cooldown" });
    const quiet = observation({ lastToldAt: toldAt });
    expect(mayRaise(quiet, now, toldAt.getTime() + HOUR_MS)).toEqual({ ok: true });
    expect(changedMaterially(quiet, now, toldAt.getTime() - HOUR_MS)).toBe(false);
  });

  it("stays silent on a topic ignored twice until it changes, and on a muted one", () => {
    const ignored = observation({ ignoredCount: 2, lastToldAt: new Date(now - 10 * DAY_MS) });
    expect(mayRaise(ignored, now)).toEqual({ ok: false, reason: "ignored_twice" });
    expect(mayRaise(ignored, now, now - HOUR_MS)).toEqual({ ok: true });
    const muted = observation({ outcomes: [{ outcome: "muted", at: now - DAY_MS }] });
    expect(mayRaise(muted, now, now - HOUR_MS)).toEqual({ ok: false, reason: "muted" });
  });
});

describe("what came of a tell", () => {
  const toldAt = at("09:45");
  const told = {
    outcomes: [{ outcome: "told" as const, at: toldAt }],
    lastToldAt: new Date(toldAt),
  };

  it("is adopted when the owner wrote within six hours, ignored once six hours passed in silence", () => {
    expect(settleOutcome(told, [toldAt + HOUR_MS], toldAt + 2 * HOUR_MS)).toBe("adopted");
    expect(settleOutcome(told, [], toldAt + 2 * HOUR_MS)).toBeNull();
    expect(settleOutcome(told, [toldAt - HOUR_MS], toldAt + 7 * HOUR_MS)).toBe("ignored");
    expect(settleOutcome(told, [toldAt + 8 * HOUR_MS], toldAt + 9 * HOUR_MS)).toBe("ignored");
  });

  it("is settled once", () => {
    const settled = {
      ...told,
      outcomes: [...told.outcomes, { outcome: "ignored" as const, at: toldAt + 7 * HOUR_MS }],
    };
    expect(settleOutcome(settled, [], toldAt + DAY_MS)).toBeNull();
  });
});
