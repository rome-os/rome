// Answers a query from the store: the plan, the points it reads and how fresh
// they are. Contract: docs/user-data.md#query.

import {
  daysFromHours,
  encodeCursor,
  listedRecord,
  planQuery,
  type QueryInput,
  type QueryPlan,
  readsDayBuckets,
  rollUp,
  type TypeResult,
} from "./domain/query.js";
import type { SourceSpec, TypeSpec } from "./domain/source.js";
import { isoInZone } from "./domain/zoned-time.js";
import type { UserDataRepository } from "./repository.js";

export interface Freshness {
  syncedThrough?: string;
  /** Whether the device reported the type complete up to the window's end. */
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

export function queryUserData(
  repo: UserDataRepository,
  source: SourceSpec,
  input: QueryInput,
  defaults: { tz: string; now: number },
): QueryAnswer | { error: string } {
  const plan = planQuery(source, input, defaults);
  if ("error" in plan) return plan;
  const origin = repo.currentOrigin(source.source);
  const synced = origin ? repo.syncedThrough(source.source, origin) : new Map<string, number>();
  const results = plan.types.map((spec) =>
    origin ? resultFor(repo, source, origin, spec, plan, defaults.now) : emptyResult(spec, plan),
  );
  const freshness: Record<string, Freshness> = {};
  for (const spec of plan.types) {
    const at = synced.get(spec.type);
    const windowEnd = Math.min(plan.end, defaults.now);
    freshness[spec.type] = {
      ...(at !== undefined ? { syncedThrough: new Date(at).toISOString() } : {}),
      coversWindow: at !== undefined && at >= windowEnd,
      ...(at === undefined
        ? { missingFrom: new Date(plan.start).toISOString() }
        : at < windowEnd
          ? { missingFrom: new Date(Math.max(at, plan.start)).toISOString() }
          : {}),
    };
  }
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
  repo: UserDataRepository,
  source: SourceSpec,
  origin: string,
  spec: TypeSpec,
  plan: QueryPlan,
  now: number,
): TypeResult | ListedRecords {
  const read = (range: Parameters<UserDataRepository["points"]>[3]) =>
    repo.points(source.source, origin, spec.type, range);
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
  if (plan.interval !== "hour") {
    const days = read({ from: plan.start, to: plan.end, resolution: "day" });
    if (readsDayBuckets(plan, days, now)) return rollUp(spec, plan, days, true);
  }
  const hours = read({ from: plan.start, to: plan.end, resolution: "hour" });
  return rollUp(spec, plan, daysFromHours(spec, plan, hours));
}
