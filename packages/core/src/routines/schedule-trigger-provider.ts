import { Cron } from "croner";
import type { TriggerProvider } from "./trigger-provider.js";
import type { Routine, ScheduleTrigger, Trigger } from "./types.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import { withoutSessionActor } from "../lib/session-actor.js";
import { createLogger } from "../logger.js";

const log = createLogger("schedule-trigger");

export class ScheduleTriggerProvider implements TriggerProvider {
  readonly type = "schedule";
  private jobs = new Map<string, Cron>();

  constructor(
    private routinesRepo: RoutinesRepository,
    /** Resolves the guardian's current timezone for `floating` schedules.
     * Defaults to the host zone so tests/callers that don't wire it
     * still get a valid IANA zone. */
    private resolveFloatingTz: () => Promise<string> = async () =>
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  ) {}

  async activate(
    routine: Routine,
    fire: (payload: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    this.deactivate(routine.id);

    const trigger = routine.trigger as ScheduleTrigger;
    // Resolve the zone this schedule fires in. `fixed` is the explicit
    // "absolute zone" choice — it pins the literal `tzid`. Anything else
    // (`floating`, or an unset mode) follows the guardian's *current* zone,
    // ignoring the stored snapshot; floating is the default so an absolute zone
    // is never selected implicitly. Everything below operates on this
    // resolved zone — croner still handles DST within it.
    const tzid = trigger.tzMode === "fixed" ? trigger.tzid : await this.resolveFloatingTz();

    // Every Cron construction below is wrapped in withoutSessionActor: timers
    // inherit the ALS context they are created in, and activate() runs inside
    // the /api request scope when a routine is created or edited — the job's
    // autonomous fires must not be attributed to that session.
    try {
      if (trigger.date) {
        // True one-off pinned to a specific calendar date. Croner accepts a
        // Date directly as the schedule expression and fires once at that
        // instant. The API rejects dates already in the past so we don't
        // need to handle that here.
        const fireAt = parseDateAndLocalTime(trigger.date, trigger.localTime, tzid);
        const job = withoutSessionActor(
          () =>
            new Cron(fireAt, { timezone: tzid, maxRuns: 1 }, async () => {
              try {
                await fire({ scheduledTime: new Date().toISOString() });
                await this.routinesRepo.updateNextRun(routine.id, null);
                await this.routinesRepo.update(routine.id, { enabled: false });
                this.jobs.delete(routine.id);
              } catch (err) {
                log.error("dated one-off schedule trigger failed", {
                  routineId: routine.id,
                  name: routine.name,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }),
        );
        this.jobs.set(routine.id, job);

        // Surface the scheduled instant so the UI / repo can show it
        try {
          await this.routinesRepo.updateNextRun(routine.id, fireAt);
        } catch (err) {
          log.warn("failed to update nextRunAt on activate (dated one-off)", {
            routineId: routine.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // Every writer resolves a one-off to a `date`, so a schedule without
        // one must recur.
        if (!trigger.rrule) throw new Error("schedule trigger has neither date nor rrule");
        const cronPattern = this.rruleToCron(trigger.rrule, trigger.localTime);
        const rule = parseRrule(trigger.rrule);
        const everyDays = rule.freq === "DAILY" && rule.interval > 1 ? rule.interval : 1;
        // Every N days counts from the creation date's calendar day in the
        // resolved zone, because createdAt is the one instant a routine keeps
        // for life. The cron pattern wakes daily, and `expected` gates off the
        // other days.
        const anchorDay = localDayNumber(routine.createdAt, tzid);
        const nextOccurrence = (): Date | null => {
          if (everyDays === 1) return job.nextRun();
          // Each pass jumps to a few hours before the next occurrence day, or
          // steps one wake when that day is tomorrow. A jump can land on the
          // day before, and the next step fixes it. Croner returns null past
          // its year cap, and so does this.
          let candidate = job.nextRun();
          for (let i = 0; candidate && i < 6; i++) {
            const day = wakeDay(candidate, trigger.localTime, tzid);
            const ahead = daysToOccurrence(day, anchorDay, everyDays);
            if (ahead === 0) return candidate;
            candidate = job.nextRun(ahead === 1 ? candidate : beforeLocalDay(day + ahead, tzid));
          }
          return null;
        };
        // The gate compares against the stored occurrence, not today's date.
        // Croner delivers a fire late when the host slept past it, and that
        // fire still counts as its occurrence on the next calendar day. With
        // no occurrence left to compute, an interval schedule never fires.
        let expected: Date | null = null;
        const job = withoutSessionActor(
          () =>
            new Cron(cronPattern, { timezone: tzid }, async () => {
              try {
                const due =
                  everyDays === 1 || (expected !== null && Date.now() >= expected.getTime());
                // Advanced before the fire, so a fire that throws or is still
                // running at the next wake cannot leave the gate on a past
                // occurrence.
                expected = nextOccurrence();
                try {
                  if (due) await fire({ scheduledTime: new Date().toISOString() });
                } finally {
                  await this.routinesRepo.updateNextRun(routine.id, expected);
                }
              } catch (err) {
                log.error("recurring schedule trigger failed", {
                  routineId: routine.id,
                  name: routine.name,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }),
        );
        this.jobs.set(routine.id, job);

        // Set initial nextRunAt — awaited so the engine + tests can rely on
        // nextRunAt being committed before activate() resolves.
        expected = nextOccurrence();
        if (expected) {
          try {
            await this.routinesRepo.updateNextRun(routine.id, expected);
          } catch (err) {
            log.warn("failed to update nextRunAt on activate", {
              routineId: routine.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      log.info("schedule trigger activated", {
        routineId: routine.id,
        name: routine.name,
        hasRrule: !!trigger.rrule,
        hasDate: !!trigger.date,
      });
    } catch (err) {
      log.error("failed to activate schedule trigger", {
        routineId: routine.id,
        name: routine.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deactivate(routineId: string): void {
    const job = this.jobs.get(routineId);
    if (job) {
      job.stop();
      this.jobs.delete(routineId);
    }
  }

  isActive(routineId: string): boolean {
    const job = this.jobs.get(routineId);
    return job !== undefined && !job.isStopped();
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
  }

  private rruleToCron(rrule: string, localTime: string): string {
    const [hour, minute] = localTime.split(":").map(Number);
    const { upper, freq, interval } = parseRrule(rrule);

    const byDayMatch = upper.match(/BYDAY=([A-Z,]+)/);

    switch (freq) {
      case "MINUTELY":
        return interval === 1 ? "* * * * *" : `*/${interval} * * * *`;
      case "HOURLY":
        return interval === 1 ? `${minute} * * * *` : `${minute} */${interval} * * *`;
      case "DAILY":
        // A day-of-month step restarts each month, so activate() applies
        // INTERVAL by skipping days instead.
        return `${minute} ${hour} * * *`;
      case "WEEKLY": {
        const dayMap: Record<string, number> = {
          SU: 0,
          MO: 1,
          TU: 2,
          WE: 3,
          TH: 4,
          FR: 5,
          SA: 6,
        };
        if (byDayMatch) {
          const days = byDayMatch[1]
            .split(",")
            .map((d) => dayMap[d] ?? 0)
            .join(",");
          return `${minute} ${hour} * * ${days}`;
        }
        return `${minute} ${hour} * * ${new Date().getDay()}`;
      }
      case "MONTHLY": {
        const byMonthDayMatch = upper.match(/BYMONTHDAY=(\d+)/);
        const day = byMonthDayMatch ? byMonthDayMatch[1] : "*";
        return interval === 1
          ? `${minute} ${hour} ${day} * *`
          : `${minute} ${hour} ${day} */${interval} *`;
      }
      case "YEARLY": {
        const byMonthMatch = upper.match(/BYMONTH=(\d+)/);
        const byMonthDayMatchY = upper.match(/BYMONTHDAY=(\d+)/);
        const month = byMonthMatch ? byMonthMatch[1] : "1";
        const day = byMonthDayMatchY ? byMonthDayMatchY[1] : "1";
        return `${minute} ${hour} ${day} ${month} *`;
      }
      default:
        return `${minute} ${hour} * * *`;
    }
  }
}

/**
 * Compute the UTC instant that corresponds to `YYYY-MM-DD HH:mm` interpreted
 * in the given IANA timezone. Uses Intl.DateTimeFormat to derive the tz's
 * UTC offset for that wall-clock date — handles DST boundaries because the
 * offset is computed against the guessed instant.
 */
export function parseDateAndLocalTime(date: string, localTime: string, tzid: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  // Treat the wall-clock fields as if they were UTC, then subtract the tz's
  // offset at that instant to get the real UTC moment.
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const guess = new Date(guessUtcMs);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, p.value]));
  const tzWallMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl can emit "24" for midnight in some locales — normalize to 0.
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    0,
  );
  const offsetMs = tzWallMs - guessUtcMs;
  return new Date(guessUtcMs - offsetMs);
}

// Storing and activating the routine takes time after the date is picked, and
// croner never fires a Date that has already passed by then.
const ONE_OFF_LEAD_MS = 5_000;

/** The "YYYY-MM-DD" in `tzid` of the next time the wall clock there reads
 * `localTime`: today if that moment is still more than a few seconds ahead of
 * `now`, else tomorrow. */
export function nextDateForLocalTime(localTime: string, tzid: string, now = new Date()): string {
  const today = calendarDate(now, tzid);
  const todayAt = parseDateAndLocalTime(today, localTime, tzid).getTime();
  if (todayAt > now.getTime() + ONE_OFF_LEAD_MS) return today;
  const [year, month, day] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** The upper-cased rule with its FREQ (DAILY when absent) and INTERVAL (1
 * when absent). */
function parseRrule(rrule: string): { upper: string; freq: string; interval: number } {
  const upper = rrule.toUpperCase();
  const freq = upper.match(/FREQ=(MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)/)?.[1] ?? "DAILY";
  const intervalMatch = upper.match(/INTERVAL=(\d+)/);
  const interval = intervalMatch ? parseInt(intervalMatch[1], 10) : 1;
  return { upper, freq, interval };
}

/** Days from local day number `day` forward to the next day of an
 * every-`interval`-days schedule counted from `anchorDay`, or 0 when `day` is
 * one. Days before the anchor follow the same spacing. */
export function daysToOccurrence(day: number, anchorDay: number, interval: number): number {
  return (((anchorDay - day) % interval) + interval) % interval;
}

/** The calendar date of `at` in `tzid`, as days since 1970-01-01. A DST
 * change never moves an instant onto a neighboring day number. */
export function localDayNumber(at: Date, tzid: string): number {
  const [year, month, day] = calendarDate(at, tzid).split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

// parseDateAndLocalTime reads the zone offset at the wrong instant on some DST
// change days, so its midnight can be up to the DST delta late. This margin
// exceeds any DST delta and stays well under a day.
const DAY_START_MARGIN_MS = 3 * 3_600_000;

/** The local day number a daily wake at `localTime` belongs to. Croner moves
 * a wake that falls in a DST gap forward by the gap, which can carry a late
 * evening wake past midnight, so a wake that reads earlier than `localTime`
 * belongs to the day before. */
function wakeDay(at: Date, localTime: string, tzid: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const [hour, minute] = localTime.split(":").map(Number);
  // Intl can emit "24" for midnight, as in parseDateAndLocalTime.
  const wokeAt = (read("hour") % 24) * 60 + read("minute");
  return localDayNumber(at, tzid) - (wokeAt < hour * 60 + minute ? 1 : 0);
}

/** An instant a few hours before the local midnight that opens day number
 * `day` in `tzid`, for croner's strictly-after `nextRun(prev)`. */
function beforeLocalDay(day: number, tzid: string): Date {
  const date = new Date(day * 86_400_000).toISOString().slice(0, 10);
  return new Date(parseDateAndLocalTime(date, "00:00", tzid).getTime() - DAY_START_MARGIN_MS);
}

/** The "YYYY-MM-DD" calendar date of `at` in `tzid`. */
function calendarDate(at: Date, tzid: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${read("year")}-${read("month")}-${read("day")}`;
}

/** Store "once at the next `localTime`" (a schedule with neither `date` nor
 * `rrule`) as the dated one-off it is, pinned `fixed`. A `floating` request
 * follows the guardian, so it is dated in, and pinned to, the guardian's zone.
 * A blank `rrule` is dropped so a schedule never carries both fields. Every
 * writer goes through this, so the scheduler only sees dated or recurring
 * schedules. Expects a validated `localTime` and `tzid`. */
export async function resolveOneOffDate(
  trigger: Trigger,
  guardianTimezone: () => Promise<string>,
): Promise<Trigger> {
  if (trigger.type !== "schedule") return trigger;
  const { rrule, ...rest } = trigger;
  const schedule: ScheduleTrigger = rrule?.trim() ? trigger : rest;
  if (schedule.date || schedule.rrule) return schedule;
  const tzid = schedule.tzMode === "floating" ? await guardianTimezone() : schedule.tzid;
  return {
    ...schedule,
    tzid,
    tzMode: "fixed",
    date: nextDateForLocalTime(schedule.localTime, tzid),
  };
}
