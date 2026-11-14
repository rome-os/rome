// Answers a query from the store: the plan, the points it reads and how fresh
// they are. Contract: docs/personal-data.md#query.

import {
  daysFromHours,
  encodeCursor,
  listedRecord,
  mergeDays,
  planQuery,
  type QueryInput,
  type QueryPlan,
  readsDayBuckets,
  rollUp,
  type TypeResult,
} from "./domain/query.js";
import type { SourceSpec, TypeSpec } from "./domain/source.js";
import { isoInZone } from "./domain/zoned-time.js";
import type { PersonalDataRepository } from "./repository.js";

export interface Freshness {
  syncedThrough?: string;
  /** The type's earliest stored reading. */
  earliest?: string;
  /** Whether the stored readings reach back to the window's start and the
   *  device reported the type complete up to its end. */
  coversWindow: boolean;
  /** Where the stored data stops covering the window. */
  missingFrom?: string;
}

export interface QueryAnswer {
  startISO: string;
  endISO: string;
  timeZoneIdentifier: string;
  interval: string;
  results: (TypeResult | ListedRecords)[];
  freshness: Record<string, Freshness>;
}

interface ListedRecords {
  type: string;
  unit: string;
  records: ReturnType<typeof listedRecord>[];
  nextCursor?: string;
}

export function queryPersonalData(
  repo: PersonalDataRepository,
  source: SourceSpec,
  input: QueryInput,
  defaults: { tz: string; now: number },
): QueryAnswer | { error: string } {
  const plan = planQuery(source, input, defaults);
  if ("error" in plan) return plan;
  const freshness: Record<string, Freshness> = {};
  const results = plan.types.map((spec) => {
    // Each type reads the origin that covers the window, so a second device
    // or a new origin after a sign-in takes over once it has caught up.
    const reading = repo.originFor(source.source, spec.type, plan.start);
    const at = reading?.syncedThroughAt ?? undefined;
    const earliest = reading?.earliestAt ?? undefined;
    const windowEnd = Math.min(plan.end, defaults.now);
    // The device reports how far it is synced, not how far back its history
    // reaches, so the earliest reading stands in for that: a window that
    // starts before it is not known to be covered.
    const reachesBack = earliest !== undefined && earliest <= plan.start;
    freshness[spec.type] = {
      ...(at !== undefined ? { syncedThrough: new Date(at).toISOString() } : {}),
      ...(earliest !== undefined ? { earliest: new Date(earliest).toISOString() } : {}),
      coversWindow: at !== undefined && at >= windowEnd && reachesBack,
      ...(at === undefined || !reachesBack
        ? { missingFrom: new Date(plan.start).toISOString() }
        : at < windowEnd
          ? { missingFrom: new Date(Math.max(at, plan.start)).toISOString() }
          : {}),
    };
    return reading
      ? resultFor(repo, source, reading.origin, spec, plan, defaults.now)
      : emptyResult(spec, plan);
  });
  return {
    startISO: isoInZone(plan.start, plan.tz),
    endISO: isoInZone(plan.end, plan.tz),
    timeZoneIdentifier: plan.tz,
    interval: plan.interval,
    results,
    freshness,
  };
}

function emptyResult(spec: TypeSpec, plan: QueryPlan): TypeResult | ListedRecords {
  if (plan.records) return { type: spec.type, unit: plan.unit ?? spec.unit, records: [] };
  return rollUp(spec, plan, []);
}

function resultFor(
  repo: PersonalDataRepository,
  source: SourceSpec,
  origin: string,
  spec: TypeSpec,
  plan: QueryPlan,
  now: number,
): TypeResult | ListedRecords {
  const by = spec.bucketBy ?? "start";
  const read = (range: Parameters<PersonalDataRepository["points"]>[3]) =>
    repo.points(source.source, origin, spec.type, { by, ...range });
  if (plan.records) {
    const rows = read({
      from: plan.start,
      to: plan.end,
      ...(plan.records.after ? { after: plan.records.after } : {}),
      limit: plan.records.limit + 1,
    });
    const page = rows.slice(0, plan.records.limit);
    const last = page.at(-1);
    return {
      type: spec.type,
      unit: plan.unit ?? spec.unit,
      records: page.map((point) => listedRecord(spec, plan, point)),
      ...(rows.length > page.length && last ? { nextCursor: encodeCursor(last) } : {}),
    };
  }
  if (spec.shape !== "bucket") return rollUp(spec, plan, read({ from: plan.start, to: plan.end }));
  const hours = read({ from: plan.start, to: plan.end, resolution: "hour" });
  if (!readsDayBuckets(plan, now)) return rollUp(spec, plan, daysFromHours(spec, plan, hours));
  const deviceDays = read({ from: plan.start, to: plan.end, resolution: "day" });
  const { days, deviceOnly } = mergeDays(spec, plan, deviceDays, hours);
  return rollUp(spec, plan, days, deviceOnly);
}
