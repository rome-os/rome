import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import type { Cron } from "croner";
import {
  isDailyOccurrence,
  nextDateForLocalTime,
  ScheduleTriggerProvider,
} from "./schedule-trigger-provider.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import type { SessionActor } from "../lib/session-actor.js";
import type { Routine, Trigger } from "./types.js";

// Reach into the provider's private `jobs` map to invoke `Cron.trigger()`
// directly. We deliberately bypass wall-clock waits and `rs.useFakeTimers`
// here — `Cron.trigger()` is croner's public "fire the callback now" API,
// which lets us assert what the provider's callback does without coupling
// to internal timer scheduling.
function jobFor(provider: ScheduleTriggerProvider, routineId: string): Cron {
  const job = (provider as unknown as { jobs: Map<string, Cron> }).jobs.get(routineId);
  if (!job) throw new Error(`no cron job for routine ${routineId}`);
  return job;
}

function buildRoutine(overrides: Partial<Routine> & { trigger: Trigger }): Routine {
  return {
    id: overrides.id ?? "r-1",
    name: overrides.name ?? "test",
    enabled: overrides.enabled ?? true,
    trigger: overrides.trigger,
    actionName: overrides.actionName ?? "noop",
    args: overrides.args ?? {},
    createdAt: overrides.createdAt ?? new Date(),
    lastFiredAt: overrides.lastFiredAt,
    nextRunAt: overrides.nextRunAt,
  };
}

describe("ScheduleTriggerProvider", () => {
  let testDb: TestDb;
  let repo: RoutinesRepository;
  let provider: ScheduleTriggerProvider;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new RoutinesRepository(testDb.db);
    provider = new ScheduleTriggerProvider(repo);
  });

  afterEach(() => {
    provider.stop();
    testDb.close();
  });

  it("sets nextRunAt on activate for a recurring routine", async () => {
    const id = await repo.create({
      name: "recurring",
      trigger: {
        type: "schedule",
        tzid: "UTC",
        tzMode: "fixed",
        localTime: "09:00",
        rrule: "FREQ=DAILY",
      },
      actionName: "noop",
      args: {},
      enabled: true,
    });
    const row = await repo.findById(id);
    expect(row).toBeTruthy();
    const routine = buildRoutine({
      id,
      trigger: row!.trigger as Trigger,
    });

    // activate() now awaits its own DB writes — no setImmediate barrier needed.
    await provider.activate(routine, async () => {});

    const after = await repo.findById(id);
    expect(after?.nextRunAt).toBeInstanceOf(Date);
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a schedule with neither date nor rrule", async () => {
    const routine = buildRoutine({
      trigger: { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "12:00" },
    });
    await provider.activate(routine, async () => {});
    expect(provider.isActive(routine.id)).toBe(false);
  });

  it("recurring: firing updates nextRunAt to a strictly later scheduled time", async () => {
    // Cron.trigger() is a manual fire — it does NOT advance the cron's internal
    // clock, so job.nextRun() returns the same calendar match unless we move
    // the system clock past it. Use fake timers + setSystemTime to position
    // before/after the daily 09:00 UTC boundary.
    rs.useFakeTimers({ shouldAdvanceTime: false });
    try {
      rs.setSystemTime(new Date("2026-05-25T08:59:00Z"));

      const id = await repo.create({
        name: "daily",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          // Pin to UTC so the asserted instants are host-zone-independent;
          // an unset tzMode would float to the host zone.
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "noop",
        args: {},
        enabled: true,
      });
      const row = await repo.findById(id);
      const routine = buildRoutine({ id, trigger: row!.trigger as Trigger });

      await provider.activate(routine, async () => {});
      const initialNext = (await repo.findById(id))!.nextRunAt;
      expect(initialNext).toBeInstanceOf(Date);
      expect(initialNext!.toISOString()).toBe("2026-05-25T09:00:00.000Z");

      // Jump just past the scheduled boundary, then manually fire. The
      // post-fire updateNextRun should now resolve to tomorrow's 09:00.
      rs.setSystemTime(new Date("2026-05-25T09:00:01Z"));
      await jobFor(provider, id).trigger();

      const after = await repo.findById(id);
      expect(after?.nextRunAt).toBeInstanceOf(Date);
      // Truthiness alone would pass even if the callback's updateNextRun
      // were deleted (the initial value would persist).
      expect(after!.nextRunAt!.getTime()).toBeGreaterThan(initialNext!.getTime());
      expect(after!.nextRunAt!.toISOString()).toBe("2026-05-26T09:00:00.000Z");
      // Recurring routines stay enabled and active
      expect(after?.enabled).toBe(true);
      expect(provider.isActive(id)).toBe(true);
    } finally {
      rs.useRealTimers();
    }
  });

  it("every two days: fires two calendar days apart across a month end", async () => {
    // A day-of-month step (*/2) matches both Oct 31 and Nov 1. The interval
    // counts from the creation date instead: Oct 29, Oct 31, Nov 2.
    rs.useFakeTimers({ shouldAdvanceTime: false });
    try {
      rs.setSystemTime(new Date("2026-10-30T23:59:00Z"));
      const id = await repo.create({
        name: "every-two-days",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "00:00",
          rrule: "FREQ=DAILY;INTERVAL=2",
        },
        actionName: "noop",
        args: {},
        enabled: true,
      });
      const row = await repo.findById(id);
      const routine = buildRoutine({
        id,
        trigger: row!.trigger as Trigger,
        createdAt: new Date("2026-10-29T12:00:00Z"),
      });

      const fire = rs.fn(async () => {});
      await provider.activate(routine, fire);
      expect((await repo.findById(id))!.nextRunAt!.toISOString()).toBe("2026-10-31T00:00:00.000Z");

      rs.setSystemTime(new Date("2026-10-31T00:00:01Z"));
      await jobFor(provider, id).trigger();
      expect(fire).toHaveBeenCalledTimes(1);
      expect((await repo.findById(id))!.nextRunAt!.toISOString()).toBe("2026-11-02T00:00:00.000Z");

      // The plain daily cron still wakes on Nov 1; the provider skips it.
      rs.setSystemTime(new Date("2026-11-01T00:00:01Z"));
      await jobFor(provider, id).trigger();
      expect(fire).toHaveBeenCalledTimes(1);
      expect((await repo.findById(id))!.nextRunAt!.toISOString()).toBe("2026-11-02T00:00:00.000Z");

      rs.setSystemTime(new Date("2026-11-02T00:00:01Z"));
      await jobFor(provider, id).trigger();
      expect(fire).toHaveBeenCalledTimes(2);
      expect((await repo.findById(id))!.nextRunAt!.toISOString()).toBe("2026-11-04T00:00:00.000Z");
    } finally {
      rs.useRealTimers();
    }
  });

  it("every two days: a fire delayed past midnight still counts as the day it was due", async () => {
    // A host asleep through the 23:30 fire runs it once on wake, the next day.
    rs.useFakeTimers({ shouldAdvanceTime: false });
    try {
      rs.setSystemTime(new Date("2026-10-31T12:00:00Z"));
      const id = await repo.create({
        name: "late-fire",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "23:30",
          rrule: "FREQ=DAILY;INTERVAL=2",
        },
        actionName: "noop",
        args: {},
        enabled: true,
      });
      const row = await repo.findById(id);
      const routine = buildRoutine({
        id,
        trigger: row!.trigger as Trigger,
        createdAt: new Date("2026-10-29T12:00:00Z"),
      });

      const fire = rs.fn(async () => {});
      await provider.activate(routine, fire);
      expect((await repo.findById(id))!.nextRunAt!.toISOString()).toBe("2026-10-31T23:30:00.000Z");

      rs.setSystemTime(new Date("2026-11-01T00:10:00Z"));
      await jobFor(provider, id).trigger();
      expect(fire).toHaveBeenCalledTimes(1);
      expect((await repo.findById(id))!.nextRunAt!.toISOString()).toBe("2026-11-02T23:30:00.000Z");
    } finally {
      rs.useRealTimers();
    }
  });

  it("every two days, floating: counts from the creation date in the guardian's current zone", async () => {
    // 2026-10-29T02:00Z is Oct 29 in UTC but Oct 28 in New York, so moving
    // the guardian between those zones shifts which days are occurrences.
    rs.useFakeTimers({ shouldAdvanceTime: false });
    let zone = "UTC";
    const floatingProvider = new ScheduleTriggerProvider(repo, async () => zone);
    try {
      rs.setSystemTime(new Date("2026-10-30T12:00:00Z"));
      const id = await repo.create({
        name: "floating-every-two-days",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "floating",
          localTime: "09:00",
          rrule: "FREQ=DAILY;INTERVAL=2",
        },
        actionName: "noop",
        args: {},
        enabled: true,
      });
      const row = await repo.findById(id);
      const routine = buildRoutine({
        id,
        trigger: row!.trigger as Trigger,
        createdAt: new Date("2026-10-29T02:00:00Z"),
      });

      await floatingProvider.activate(routine, async () => {});
      // UTC anchor Oct 29: Oct 31 09:00 UTC.
      expect((await repo.findById(id))!.nextRunAt!.toISOString()).toBe("2026-10-31T09:00:00.000Z");

      zone = "America/New_York";
      await floatingProvider.activate(routine, async () => {});
      // New York anchor Oct 28: Oct 30 09:00 EDT.
      expect((await repo.findById(id))!.nextRunAt!.toISOString()).toBe("2026-10-30T13:00:00.000Z");
    } finally {
      floatingProvider.stop();
      rs.useRealTimers();
    }
  });

  it("dated one-off: fires at the specified date+time, consumes, drops job", async () => {
    // activate() schedules a single Cron(Date,...) fire; manual trigger() invokes the callback, which records the fire
    // and marks the routine consumed.
    rs.useFakeTimers({ shouldAdvanceTime: false });
    try {
      rs.setSystemTime(new Date("2099-12-30T00:00:00Z"));
      const id = await repo.create({
        name: "dated-one-off",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          // Pin to UTC so the asserted fire instant is host-zone-independent.
          tzMode: "fixed",
          localTime: "10:00",
          date: "2099-12-31",
        },
        actionName: "noop",
        args: {},
        enabled: true,
      });
      const row = await repo.findById(id);
      const routine = buildRoutine({ id, trigger: row!.trigger as Trigger });

      const firedPayloads: Record<string, unknown>[] = [];
      await provider.activate(routine, async (p) => {
        firedPayloads.push(p);
      });
      expect(provider.isActive(id)).toBe(true);

      // nextRunAt was committed to the dated instant
      const afterActivate = await repo.findById(id);
      expect(afterActivate!.nextRunAt!.toISOString()).toBe("2099-12-31T10:00:00.000Z");

      await jobFor(provider, id).trigger();

      expect(firedPayloads).toHaveLength(1);
      const after = await repo.findById(id);
      expect(after?.enabled).toBe(false);
      expect(after?.nextRunAt).toBeNull();
      expect(provider.isActive(id)).toBe(false);
    } finally {
      rs.useRealTimers();
    }
  });

  it("floating: resolves the cron timezone from the guardian resolver, ignoring the stored tzid", async () => {
    // The stored tzid is a stale snapshot; a floating routine must fire in the
    // guardian's *current* zone. Inject a resolver returning a zone
    // that differs from the snapshot and assert the croner job uses it.
    const floatingProvider = new ScheduleTriggerProvider(repo, async () => "America/New_York");
    const id = await repo.create({
      name: "floating",
      trigger: {
        type: "schedule",
        tzid: "UTC", // snapshot — should be ignored
        tzMode: "floating",
        localTime: "09:00",
        rrule: "FREQ=DAILY",
      },
      actionName: "noop",
      args: {},
      enabled: true,
    });
    const row = await repo.findById(id);
    const routine = buildRoutine({ id, trigger: row!.trigger as Trigger });

    await floatingProvider.activate(routine, async () => {});
    try {
      const job = jobFor(floatingProvider, id) as unknown as { options: { timezone?: string } };
      expect(job.options.timezone).toBe("America/New_York");
    } finally {
      floatingProvider.stop();
    }
  });

  it("explicit fixed: pins the literal tzid, ignoring the guardian resolver", async () => {
    const floatingProvider = new ScheduleTriggerProvider(repo, async () => "America/New_York");
    const id = await repo.create({
      name: "fixed",
      // tzMode: "fixed" is the explicit absolute-zone choice — fire in Tokyo
      // regardless of where the guardian currently is.
      trigger: {
        type: "schedule",
        tzid: "Asia/Tokyo",
        tzMode: "fixed",
        localTime: "09:00",
        rrule: "FREQ=DAILY",
      },
      actionName: "noop",
      args: {},
      enabled: true,
    });
    const row = await repo.findById(id);
    const routine = buildRoutine({ id, trigger: row!.trigger as Trigger });

    await floatingProvider.activate(routine, async () => {});
    try {
      const job = jobFor(floatingProvider, id) as unknown as { options: { timezone?: string } };
      expect(job.options.timezone).toBe("Asia/Tokyo");
    } finally {
      floatingProvider.stop();
    }
  });

  it("deactivate stops the cron job AND drops it from the active set", async () => {
    const id = await repo.create({
      name: "stop-me",
      trigger: {
        type: "schedule",
        tzid: "UTC",
        tzMode: "fixed",
        localTime: "09:00",
        rrule: "FREQ=DAILY",
      },
      actionName: "noop",
      args: {},
      enabled: true,
    });
    const row = await repo.findById(id);
    const routine = buildRoutine({ id, trigger: row!.trigger as Trigger });

    await provider.activate(routine, async () => {});
    expect(provider.isActive(id)).toBe(true);
    // Hold a reference to the underlying cron job so we can prove it was
    // actually stopped — not just removed from the map.
    const job = jobFor(provider, id);
    expect(job.isStopped()).toBe(false);

    provider.deactivate(id);
    expect(provider.isActive(id)).toBe(false);
    expect(job.isStopped()).toBe(true);
  });

  // Timers inherit the ALS context they are created in, so a routine
  // activated from an /api request must construct its cron jobs outside the
  // request's session-actor scope or every autonomous fire is attributed to
  // that session. A mocked Cron captures the ambient actor at construction —
  // the moment the real croner registers its timer.
  it("constructs cron jobs outside the ambient session-actor scope (both branches)", async () => {
    // rs.resetModules gives the re-imported provider a FRESH session-actor
    // module (fresh ALS instance), so the scope must be entered and observed
    // through that same fresh module — not this file's top-level import.
    const capturedAtConstruction: Promise<SessionActor | undefined>[] = [];
    rs.resetModules();
    const freshSessionActor = await import("../lib/session-actor.js");
    rs.doMock("croner", () => ({
      Cron: class {
        constructor() {
          capturedAtConstruction.push(freshSessionActor.currentSessionActor());
        }
        nextRun() {
          return new Date(Date.now() + 60_000);
        }
        stop() {}
        isStopped() {
          return true;
        }
      },
    }));
    try {
      const { ScheduleTriggerProvider: MockedProvider } = await import(
        "./schedule-trigger-provider.js"
      );
      const { runWithSessionActor, currentSessionActor } = freshSessionActor;
      const mocked = new MockedProvider(repo);
      const actor: SessionActor = { kind: "guardian", userId: "seat-1", via: "cookie" };
      const triggers: Trigger[] = [
        // dated one-off, recurring — one per Cron construction
        { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "09:00", date: "2099-01-02" },
        { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "09:00", rrule: "FREQ=DAILY" },
      ];

      await runWithSessionActor(actor, async () => {
        expect(await currentSessionActor()).toEqual(actor);
        for (const [i, trigger] of triggers.entries()) {
          await mocked.activate(buildRoutine({ id: `r-actor-${i}`, trigger }), async () => {});
        }
      });

      expect(capturedAtConstruction).toHaveLength(2);
      for (const captured of capturedAtConstruction) {
        expect(await captured).toBeUndefined();
      }
      mocked.stop();
    } finally {
      rs.doUnmock("croner");
      rs.resetModules();
    }
  });
});

describe("nextDateForLocalTime", () => {
  it("rolls to tomorrow when today's time is only seconds away", () => {
    const now = new Date("2026-06-23T08:59:58Z");
    expect(nextDateForLocalTime("09:00", "UTC", now)).toBe("2026-06-24");
    expect(nextDateForLocalTime("09:01", "UTC", now)).toBe("2026-06-23");
  });
});

describe("isDailyOccurrence", () => {
  it("keeps every-other-day parity across the November DST change", () => {
    const anchor = new Date("2026-10-30T13:00:00Z"); // Oct 30, 09:00 EDT
    const tz = "America/New_York";
    // Nov 1 is the fall-back day; Nov 3 09:00 is EST.
    expect(isDailyOccurrence(new Date("2026-11-01T13:00:00Z"), anchor, tz, 2)).toBe(true);
    expect(isDailyOccurrence(new Date("2026-11-02T14:00:00Z"), anchor, tz, 2)).toBe(false);
    expect(isDailyOccurrence(new Date("2026-11-03T14:00:00Z"), anchor, tz, 2)).toBe(true);
  });

  it("counts a leap day", () => {
    const anchor = new Date("2028-02-27T09:00:00Z");
    expect(isDailyOccurrence(new Date("2028-02-29T09:00:00Z"), anchor, "UTC", 2)).toBe(true);
    expect(isDailyOccurrence(new Date("2028-03-01T09:00:00Z"), anchor, "UTC", 2)).toBe(false);
    expect(isDailyOccurrence(new Date("2028-03-02T09:00:00Z"), anchor, "UTC", 3)).toBe(false);
    expect(isDailyOccurrence(new Date("2028-03-01T09:00:00Z"), anchor, "UTC", 3)).toBe(true);
  });

  it("treats days before the anchor by the same spacing", () => {
    const anchor = new Date("2026-10-29T12:00:00Z");
    expect(isDailyOccurrence(new Date("2026-10-27T00:00:00Z"), anchor, "UTC", 2)).toBe(true);
    expect(isDailyOccurrence(new Date("2026-10-28T00:00:00Z"), anchor, "UTC", 2)).toBe(false);
  });
});
