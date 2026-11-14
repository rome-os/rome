// The personal-data store's one way into the database. Concept: docs/personal-data.md.

import { and, asc, count, desc, eq, gt, gte, lt, max, min, ne, or, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import {
  personalDataIngests,
  personalDataPoints,
  personalDataSources,
  personalDataTypes,
} from "../db/schema/system.js";
import {
  checkDelete,
  checkUpsert,
  type IngestEnvelope,
  MAX_POINTS_PER_TYPE,
  type PointInput,
  type Rejected,
} from "./domain/ingest.js";
import type { StoredPoint } from "./domain/query.js";
import type { Resolution, Shape, SourceSpec } from "./domain/source.js";
import { typeSpec } from "./domain/source.js";

/** How far ahead of Rome's clock a device may report a type synced. */
const MAX_CLOCK_AHEAD_MS = 86_400_000;

/** How long the ingest log keeps a row. */
const INGEST_LOG_DAYS = 90;

export type OriginState = "active" | "paused" | "off";

export interface IngestResponse {
  batchId: string;
  status: "ok" | "partial";
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  rejected: Rejected[];
  receivedAt: string;
}

export interface CatalogType {
  type: string;
  shape: string;
  unit: string | null;
  resolutions?: string[];
  pointCount: number;
  earliest?: string;
  latest?: string;
  syncedThrough?: string;
}

export interface CatalogSource {
  source: string;
  title: string;
  note: string;
  origin: { id: string; name: string | null; platform: string | null; appVersion: string | null };
  state: OriginState;
  firstSyncAt?: string;
  lastSyncAt?: string;
  lastResult?: string;
  lastErrorCode?: string;
  types: CatalogType[];
  live?: { how: string; device: string; when: string };
}

export interface IngestLogEntry {
  id: number;
  origin: string;
  batchId: string | null;
  trigger: string | null;
  receivedAt: string;
  itemCount: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  rejected: number;
  rangeStart?: string;
  rangeEnd?: string;
  durationMs: number | null;
  status: string;
  errorCode: string | null;
}

const iso = (at: number | null | undefined) =>
  at === null || at === undefined ? undefined : new Date(at).toISOString();

export class PersonalDataRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly sources: readonly SourceSpec[],
  ) {}

  /**
   * Applies one batch in one transaction, the catalog included. A batch id
   * the origin already sent returns the answer it got then and writes
   * nothing. Each item is checked on its own: a refused item is listed in
   * `rejected` and the rest applies.
   */
  ingest(
    source: SourceSpec,
    envelope: IngestEnvelope,
    receivedAt: number,
  ): { response: IngestResponse; repeated: boolean } {
    return this.db.transaction((tx) => {
      const origin = envelope.origin.id;
      const earlier = tx
        .select({ response: personalDataIngests.response })
        .from(personalDataIngests)
        .where(
          and(
            eq(personalDataIngests.source, source.source),
            eq(personalDataIngests.origin, origin),
            eq(personalDataIngests.batchId, envelope.batch.id),
          ),
        )
        .get();
      if (earlier?.response) {
        return { response: earlier.response as unknown as IngestResponse, repeated: true };
      }

      upsertSource(tx, source, envelope, receivedAt);
      const ingestId = tx
        .insert(personalDataIngests)
        .values({
          source: source.source,
          origin,
          batchId: envelope.batch.id,
          trigger: envelope.batch.trigger ?? null,
          receivedAt,
          itemCount: envelope.upserts.length + envelope.deletes.length,
          status: "ok",
        })
        .returning({ id: personalDataIngests.id })
        .get().id;

      const counts = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
      // Rows per type, counted once per batch and kept current as it inserts.
      const stored = new Map<string, number>();
      const rejected: Rejected[] = [];
      const touched = new Set<string>();
      let rangeStart: number | undefined;
      let rangeEnd: number | undefined;

      envelope.upserts.forEach((raw, index) => {
        const checked = checkUpsert(source, raw, receivedAt);
        if (!checked.ok) {
          rejected.push({
            index,
            ...(checked.key ? { key: checked.key } : {}),
            code: checked.code,
          });
          return;
        }
        const item = checked.item;
        const outcome = writePoint(tx, source.source, origin, item, ingestId, receivedAt, stored);
        if (outcome === "type_cap") {
          rejected.push({ index, key: item.key, code: "type_cap" });
          return;
        }
        counts[outcome] += 1;
        touched.add(item.type);
        rangeStart = Math.min(rangeStart ?? item.startAt, item.startAt);
        rangeEnd = Math.max(rangeEnd ?? item.endAt, item.endAt);
      });
      envelope.deletes.forEach((raw, offset) => {
        const index = envelope.upserts.length + offset;
        const checked = checkDelete(raw);
        if (!checked.ok) {
          rejected.push({
            index,
            ...(checked.key ? { key: checked.key } : {}),
            code: checked.code,
          });
          return;
        }
        const gone = tx
          .delete(personalDataPoints)
          .where(
            and(
              eq(personalDataPoints.source, source.source),
              eq(personalDataPoints.origin, origin),
              eq(personalDataPoints.dedupeKey, checked.item.key),
            ),
          )
          .returning({ type: personalDataPoints.type })
          .all();
        if (gone.length === 0) {
          counts.unchanged += 1;
          return;
        }
        counts.deleted += 1;
        for (const row of gone) touched.add(row.type);
      });

      const syncedThrough = new Map<string, number>();
      for (const entry of envelope.types) {
        if (!typeSpec(source, entry.type) || !entry.syncedThrough) continue;
        const at = Date.parse(entry.syncedThrough);
        // A device clock ahead of Rome's would mark the type covered for good.
        if (at > receivedAt + MAX_CLOCK_AHEAD_MS) continue;
        syncedThrough.set(entry.type, at);
        touched.add(entry.type);
      }
      for (const type of touched) {
        refreshType(tx, source, origin, type, syncedThrough.get(type), receivedAt);
      }

      const status = rejected.length > 0 ? "partial" : "ok";
      const response: IngestResponse = {
        batchId: envelope.batch.id,
        status,
        ...counts,
        rejected,
        receivedAt: new Date(receivedAt).toISOString(),
      };
      tx.update(personalDataIngests)
        .set({
          ...counts,
          rejected: rejected.length,
          rangeStartAt: rangeStart ?? null,
          rangeEndAt: rangeEnd ?? null,
          durationMs: Date.now() - receivedAt,
          status,
          response: response as unknown as Record<string, unknown>,
        })
        .where(eq(personalDataIngests.id, ingestId))
        .run();
      tx.update(personalDataSources)
        .set({ lastSyncAt: receivedAt, lastResult: status, lastErrorCode: null })
        .where(sourceRow(source.source, origin))
        .run();
      tx.delete(personalDataIngests)
        .where(lt(personalDataIngests.receivedAt, receivedAt - INGEST_LOG_DAYS * 86_400_000))
        .run();
      return { response, repeated: false };
    });
  }

  /** Every source and origin with its types, the active origins first. */
  catalog(): CatalogSource[] {
    const sources = this.db
      .select()
      .from(personalDataSources)
      .orderBy(desc(personalDataSources.lastSyncAt))
      .all();
    const types = this.db
      .select()
      .from(personalDataTypes)
      .orderBy(asc(personalDataTypes.type))
      .all();
    return sources
      .flatMap((row): CatalogSource[] => {
        const spec = this.sources.find((s) => s.source === row.source);
        if (!spec) return [];
        const entry: CatalogSource = {
          source: row.source,
          title: spec.title,
          note: row.note ?? spec.note,
          origin: {
            id: row.origin,
            name: row.originName,
            platform: row.platform,
            appVersion: row.appVersion,
          },
          state: row.state as OriginState,
          types: types
            .filter((t) => t.source === row.source && t.origin === row.origin)
            .map((t) => ({
              type: t.type,
              shape: t.shape,
              unit: t.unit,
              ...(t.shape === "bucket" ? { resolutions: t.resolutions } : {}),
              pointCount: t.pointCount,
              ...(iso(t.earliestAt) ? { earliest: iso(t.earliestAt) } : {}),
              ...(iso(t.latestAt) ? { latest: iso(t.latestAt) } : {}),
              ...(iso(t.syncedThroughAt) ? { syncedThrough: iso(t.syncedThroughAt) } : {}),
            })),
        };
        if (row.firstSyncAt) entry.firstSyncAt = iso(row.firstSyncAt);
        if (row.lastSyncAt) entry.lastSyncAt = iso(row.lastSyncAt);
        if (row.lastResult) entry.lastResult = row.lastResult;
        if (row.lastErrorCode) entry.lastErrorCode = row.lastErrorCode;
        if (spec.live) {
          entry.live = {
            how: spec.live.how,
            device: row.originName ?? "the device",
            when: spec.live.when,
          };
        }
        return [entry];
      })
      .sort((a, b) => Number(b.state === "active") - Number(a.state === "active"));
  }

  /**
   * The origin a query of `type` reads: the one whose device reports the type
   * synced furthest, then the one with the latest reading. An origin set off
   * is never read. Undefined when no origin has the type.
   */
  originFor(
    source: string,
    type: string,
  ): { origin: string; syncedThroughAt: number | null } | undefined {
    return this.db
      .select({
        origin: personalDataTypes.origin,
        syncedThroughAt: personalDataTypes.syncedThroughAt,
      })
      .from(personalDataTypes)
      .innerJoin(
        personalDataSources,
        and(
          eq(personalDataSources.source, personalDataTypes.source),
          eq(personalDataSources.origin, personalDataTypes.origin),
        ),
      )
      .where(
        and(
          eq(personalDataTypes.source, source),
          eq(personalDataTypes.type, type),
          ne(personalDataSources.state, "off"),
        ),
      )
      .orderBy(
        sql`coalesce(${personalDataTypes.syncedThroughAt}, 0) desc`,
        sql`coalesce(${personalDataTypes.latestAt}, 0) desc`,
      )
      .limit(1)
      .get();
  }

  /** An origin's points of one type that start in `[from, to)`, or end in it
   *  with `by: "end"`, oldest first. */
  points(
    source: string,
    origin: string,
    type: string,
    range: {
      from: number;
      to: number;
      by?: "start" | "end";
      resolution?: Resolution;
      after?: { startAt: number; id: number };
      limit?: number;
    },
  ): StoredPoint[] {
    const after = range.after;
    const query = this.db
      .select({
        id: personalDataPoints.id,
        type: personalDataPoints.type,
        shape: personalDataPoints.shape,
        resolution: personalDataPoints.resolution,
        startAt: personalDataPoints.startAt,
        endAt: personalDataPoints.endAt,
        tz: personalDataPoints.tz,
        value: personalDataPoints.value,
        fields: personalDataPoints.fields,
        metadata: personalDataPoints.metadata,
      })
      .from(personalDataPoints)
      .where(
        and(
          eq(personalDataPoints.source, source),
          eq(personalDataPoints.type, type),
          range.resolution ? eq(personalDataPoints.resolution, range.resolution) : undefined,
          eq(personalDataPoints.origin, origin),
          gte(
            range.by === "end" ? personalDataPoints.endAt : personalDataPoints.startAt,
            range.from,
          ),
          lt(range.by === "end" ? personalDataPoints.endAt : personalDataPoints.startAt, range.to),
          after
            ? or(
                gt(personalDataPoints.startAt, after.startAt),
                and(
                  eq(personalDataPoints.startAt, after.startAt),
                  gt(personalDataPoints.id, after.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(personalDataPoints.startAt), asc(personalDataPoints.id));
    const rows = range.limit ? query.limit(range.limit).all() : query.all();
    return rows.map((row) => ({
      ...row,
      shape: row.shape as Shape,
      resolution: row.resolution as Resolution | null,
    }));
  }

  /** Sets an origin's state. False when the origin never sent this source. */
  setState(source: string, origin: string, state: OriginState): boolean {
    const changed = this.db
      .update(personalDataSources)
      .set({ state })
      .where(sourceRow(source, origin))
      .returning({ origin: personalDataSources.origin })
      .all();
    return changed.length > 0;
  }

  /**
   * Deletes every point and type row of an origin, sets it off and logs one
   * `deleted` row. The ingest log stays. Undefined when the origin never sent
   * this source.
   */
  deleteOrigin(source: string, origin: string, at: number): { deletedPoints: number } | undefined {
    return this.db.transaction((tx) => {
      const known = tx.select().from(personalDataSources).where(sourceRow(source, origin)).get();
      if (!known) return undefined;
      const deletedPoints =
        tx
          .select({ n: count() })
          .from(personalDataPoints)
          .where(and(eq(personalDataPoints.source, source), eq(personalDataPoints.origin, origin)))
          .get()?.n ?? 0;
      tx.delete(personalDataPoints)
        .where(and(eq(personalDataPoints.source, source), eq(personalDataPoints.origin, origin)))
        .run();
      tx.delete(personalDataTypes)
        .where(and(eq(personalDataTypes.source, source), eq(personalDataTypes.origin, origin)))
        .run();
      tx.update(personalDataSources).set({ state: "off" }).where(sourceRow(source, origin)).run();
      tx.insert(personalDataIngests)
        .values({
          source,
          origin,
          receivedAt: at,
          deleted: deletedPoints,
          status: "deleted",
          durationMs: 0,
        })
        .run();
      return { deletedPoints };
    });
  }

  /** The source's ingest log, newest first. */
  ingests(source: string, limit: number): IngestLogEntry[] {
    return this.db
      .select()
      .from(personalDataIngests)
      .where(eq(personalDataIngests.source, source))
      .orderBy(desc(personalDataIngests.receivedAt), desc(personalDataIngests.id))
      .limit(limit)
      .all()
      .map((row) => ({
        id: row.id,
        origin: row.origin,
        batchId: row.batchId,
        trigger: row.trigger,
        receivedAt: new Date(row.receivedAt).toISOString(),
        itemCount: row.itemCount,
        inserted: row.inserted,
        updated: row.updated,
        unchanged: row.unchanged,
        deleted: row.deleted,
        rejected: row.rejected,
        ...(iso(row.rangeStartAt) ? { rangeStart: iso(row.rangeStartAt) } : {}),
        ...(iso(row.rangeEndAt) ? { rangeEnd: iso(row.rangeEndAt) } : {}),
        durationMs: row.durationMs,
        status: row.status,
        errorCode: row.errorCode,
      }));
  }
}

function sourceRow(source: string, origin: string) {
  return and(eq(personalDataSources.source, source), eq(personalDataSources.origin, origin));
}

function upsertSource(
  tx: DrizzleTx,
  source: SourceSpec,
  envelope: IngestEnvelope,
  receivedAt: number,
): void {
  const refreshed = {
    ...(envelope.origin.name !== undefined ? { originName: envelope.origin.name } : {}),
    ...(envelope.origin.platform !== undefined ? { platform: envelope.origin.platform } : {}),
    ...(envelope.origin.appVersion !== undefined ? { appVersion: envelope.origin.appVersion } : {}),
    // A batch means the device syncs, so an origin set off by a delete is back.
    state: "active",
    note: source.note,
  };
  tx.insert(personalDataSources)
    .values({
      source: source.source,
      origin: envelope.origin.id,
      firstSyncAt: receivedAt,
      ...refreshed,
    })
    .onConflictDoUpdate({
      target: [personalDataSources.source, personalDataSources.origin],
      set: {
        ...refreshed,
        firstSyncAt: sql`coalesce(${personalDataSources.firstSyncAt}, ${receivedAt})`,
      },
    })
    .run();
}

function writePoint(
  tx: DrizzleTx,
  source: string,
  origin: string,
  item: PointInput,
  ingestId: number,
  now: number,
  stored: Map<string, number>,
): "inserted" | "updated" | "unchanged" | "type_cap" {
  const existing = tx
    .select({ id: personalDataPoints.id, hash: personalDataPoints.contentHash })
    .from(personalDataPoints)
    .where(
      and(
        eq(personalDataPoints.source, source),
        eq(personalDataPoints.origin, origin),
        eq(personalDataPoints.dedupeKey, item.key),
      ),
    )
    .get();
  if (existing?.hash === item.contentHash) return "unchanged";
  const values = {
    type: item.type,
    shape: item.shape,
    resolution: item.resolution,
    startAt: item.startAt,
    endAt: item.endAt,
    tz: item.tz,
    value: item.value,
    unit: item.unit,
    fields: item.fields,
    metadata: item.metadata,
    contentHash: item.contentHash,
    ingestId,
    updatedAt: now,
  };
  if (existing) {
    tx.update(personalDataPoints).set(values).where(eq(personalDataPoints.id, existing.id)).run();
    return "updated";
  }
  let held: number | undefined;
  if (item.shape !== "bucket") {
    held =
      stored.get(item.type) ??
      tx
        .select({ n: count() })
        .from(personalDataPoints)
        .where(
          and(
            eq(personalDataPoints.source, source),
            eq(personalDataPoints.type, item.type),
            eq(personalDataPoints.origin, origin),
          ),
        )
        .get()?.n ??
      0;
    if (held >= MAX_POINTS_PER_TYPE) {
      stored.set(item.type, held);
      return "type_cap";
    }
  }
  tx.insert(personalDataPoints)
    .values({ source, origin, dedupeKey: item.key, ...values })
    .run();
  if (held !== undefined) stored.set(item.type, held + 1);
  return "inserted";
}

function refreshType(
  tx: DrizzleTx,
  source: SourceSpec,
  origin: string,
  type: string,
  syncedThroughAt: number | undefined,
  now: number,
): void {
  const spec = typeSpec(source, type);
  if (!spec) return;
  const stats = tx
    .select({
      n: count(),
      earliest: min(personalDataPoints.startAt),
      latest: max(personalDataPoints.endAt),
    })
    .from(personalDataPoints)
    .where(
      and(
        eq(personalDataPoints.source, source.source),
        eq(personalDataPoints.type, type),
        eq(personalDataPoints.origin, origin),
      ),
    )
    .get();
  const values = {
    shape: spec.shape,
    unit: spec.unit,
    resolutions: [...(spec.resolutions ?? [])],
    earliestAt: stats?.earliest ?? null,
    latestAt: stats?.latest ?? null,
    pointCount: stats?.n ?? 0,
    updatedAt: now,
  };
  tx.insert(personalDataTypes)
    .values({
      source: source.source,
      origin,
      type,
      ...values,
      syncedThroughAt: syncedThroughAt ?? null,
    })
    .onConflictDoUpdate({
      target: [personalDataTypes.source, personalDataTypes.origin, personalDataTypes.type],
      // Synced-through only moves forward: a late batch from an older sync
      // does not take back what a newer one reported.
      set:
        syncedThroughAt === undefined
          ? values
          : {
              ...values,
              syncedThroughAt: sql`max(coalesce(${personalDataTypes.syncedThroughAt}, 0), ${syncedThroughAt})`,
            },
    })
    .run();
}
