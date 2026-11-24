// How often the patrol may speak, and about what: the daily cap it shares with
// alerts and digests, the cooldown of a topic, quiet hours, digest times and
// the slow-down while the guardian is away. Every rule here is code, so no
// model decides it. docs/architecture/concierge-patrol.md#volume

import type { Observation } from "../../db/repositories/concierge-observations.js";
import { type QuietHours, quietWindowEnd } from "../alerts.js";

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
/** Proactive messages a day, counted across alerts, digests and the patrol. Only the patrol is held by it. */
export const DAILY_MESSAGE_CAP = 3;
/** A topic told is not told again for this long, unless it changed materially. */
export const COOLDOWN_MS = 3 * DAY_MS;
/** A topic ignored this many times is not told again until it changes materially. */
const IGNORED_LIMIT = 2;
/** A reply in the main chat within this long of a tell adopts it; none ignores it. */
const OUTCOME_WINDOW_MS = 6 * HOUR_MS;
/** A due time this close counts as near: it can bring a told topic back. */
const DEADLINE_NEAR_MS = DAY_MS;
/** The patrol says nothing this close to a digest time, before or after it. */
const DIGEST_MARGIN_MS = 30 * 60_000;
/** Quiet hours the patrol keeps when its owner set none: it never speaks at night. */
const DEFAULT_PATROL_QUIET: QuietHours = { start: "22:00", end: "08:00" };

/** Why the patrol may not speak now, or null when it may. */
export type HoldReason = "quiet_hours" | "near_digest" | "daily_cap" | "resting";

/** When the quiet window `at` falls in ends, or null outside it. Its owner's window, else the patrol's own. */
export function patrolQuietUntil(
  at: number,
  quiet: QuietHours | null,
  timeZone: string,
): number | null {
  return quietWindowEnd(at, quiet ?? DEFAULT_PATROL_QUIET, timeZone);
}

const minutesOf = (hhmm: string) => {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

function localMinutes(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

/** Whether `at` is within {@link DIGEST_MARGIN_MS} of one of the digest times, in `timeZone`. */
export function nearDigest(at: number, digestTimes: readonly string[], timeZone: string): boolean {
  const now = localMinutes(at, timeZone);
  const margin = DIGEST_MARGIN_MS / 60_000;
  return digestTimes.some((time) => {
    const gap = Math.abs(now - minutesOf(time));
    return Math.min(gap, 24 * 60 - gap) <= margin;
  });
}

/**
 * How long after its last run the patrol runs again, by how long ago its
 * owner last wrote: every fire while they are around, every other fire after
 * a day away, and once a day after three days away or when they never wrote.
 */
export function restGap(lastOwnerMessageAt: number | null, now: number, intervalMs: number) {
  const away = lastOwnerMessageAt === null ? Number.POSITIVE_INFINITY : now - lastOwnerMessageAt;
  if (away < DAY_MS) return 0;
  if (away < 3 * DAY_MS) return 2 * intervalMs - 10 * 60_000;
  return DAY_MS - 10 * 60_000;
}

/** The facts that decide whether the patrol may speak at all now. */
export interface HoldFacts {
  now: number;
  timeZone: string;
  quietHours: QuietHours | null;
  digestTimes: readonly string[];
  /** Proactive messages told in the last day, of every kind. */
  toldToday: number;
  /** When the patrol last ran past its pre-check, or null. */
  lastRunAt: number | null;
  lastOwnerMessageAt: number | null;
  intervalMs: number;
  /** A wake-up the patrol set itself, which no rest holds back. */
  recheck: boolean;
}

/**
 * When the patrol next runs at a time it may speak, epoch milliseconds: the
 * first of its next fires, `intervalMs` apart, that is outside quiet hours
 * and clear of every digest time. Null when none is within a day.
 */
export function nextSpeakingRun(
  now: number,
  intervalMs: number,
  quietHours: QuietHours | null,
  digestTimes: readonly string[],
  timeZone: string,
): number | null {
  for (let at = now + intervalMs; at <= now + DAY_MS; at += intervalMs) {
    if (patrolQuietUntil(at, quietHours, timeZone) !== null) continue;
    if (nearDigest(at, digestTimes, timeZone)) continue;
    return at;
  }
  return null;
}

/** Why the patrol holds now, checked before anything is read, or null. */
export function holdReason(facts: HoldFacts): HoldReason | null {
  if (patrolQuietUntil(facts.now, facts.quietHours, facts.timeZone) !== null) return "quiet_hours";
  if (facts.toldToday >= DAILY_MESSAGE_CAP) return "daily_cap";
  if (nearDigest(facts.now, facts.digestTimes, facts.timeZone)) return "near_digest";
  if (!facts.recheck && facts.lastRunAt !== null) {
    const gap = restGap(facts.lastOwnerMessageAt, facts.now, facts.intervalMs);
    if (facts.now - facts.lastRunAt < gap) return "resting";
  }
  return null;
}

/**
 * Whether a told topic changed enough to be told again before its cooldown
 * ends: its due time came near since it was told, or its task moved on.
 */
export function changedMaterially(
  observation: Pick<Observation, "dueAt" | "lastToldAt">,
  now: number,
  taskUpdatedAt: number | null,
): boolean {
  const told = observation.lastToldAt?.getTime() ?? null;
  if (told === null) return true;
  const due = observation.dueAt?.getTime() ?? null;
  if (due !== null && due > now && due - now <= DEADLINE_NEAR_MS && due - told > DEADLINE_NEAR_MS) {
    return true;
  }
  return taskUpdatedAt !== null && taskUpdatedAt > told;
}

export type RaiseVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "not_open" | "inferred" | "muted" | "cooldown" | "ignored_twice" | "low_confidence";
    };

/** The least confidence an observation needs to be told. */
const MIN_CONFIDENCE = 0.6;

/**
 * Whether the patrol may tell an observation now, by its own record. An
 * inferred observation is never told: only a fact Rome holds is a reason to speak.
 */
export function mayRaise(
  observation: Pick<
    Observation,
    "status" | "basis" | "confidence" | "outcomes" | "lastToldAt" | "ignoredCount" | "dueAt"
  >,
  now: number,
  taskUpdatedAt: number | null = null,
): RaiseVerdict {
  if (observation.status !== "open") return { ok: false, reason: "not_open" };
  if (observation.basis !== "observed") return { ok: false, reason: "inferred" };
  if (observation.confidence < MIN_CONFIDENCE) return { ok: false, reason: "low_confidence" };
  if (observation.outcomes.some((outcome) => outcome.outcome === "muted")) {
    return { ok: false, reason: "muted" };
  }
  const changed = changedMaterially(observation, now, taskUpdatedAt);
  if (observation.ignoredCount >= IGNORED_LIMIT && !changed) {
    return { ok: false, reason: "ignored_twice" };
  }
  const told = observation.lastToldAt?.getTime() ?? null;
  if (told !== null && now - told < COOLDOWN_MS && !changed) {
    return { ok: false, reason: "cooldown" };
  }
  return { ok: true };
}

/**
 * What came of the last tell of an observation, once it can be told: adopted
 * when its owner wrote in the main chat within {@link OUTCOME_WINDOW_MS} of
 * it, ignored when the window passed with no word. Null while it is still
 * open, or when nothing waits.
 */
export function settleOutcome(
  observation: Pick<Observation, "outcomes" | "lastToldAt">,
  ownerMessageTimes: readonly number[],
  now: number,
): "adopted" | "ignored" | null {
  const last = observation.outcomes.at(-1);
  const told = observation.lastToldAt?.getTime() ?? null;
  if (last?.outcome !== "told" || told === null) return null;
  const replied = ownerMessageTimes.some((at) => at > told && at <= told + OUTCOME_WINDOW_MS);
  if (replied) return "adopted";
  return now - told > OUTCOME_WINDOW_MS ? "ignored" : null;
}
