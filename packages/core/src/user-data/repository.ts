// The user-data store's one way into the database. Concept: docs/user-data.md.

import { and, asc, count, desc, eq, gt, gte, lt, max, min, or, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import {
  userDataIngests,
  userDataPoints,
  userDataSources,
  userDataTypes,
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

export class UserDataRepository {
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
        .select({ response: userDataIngests.response })
        .from(userDataIngests)
        .where(
          and(
            eq(userDataIngests.source, source.source),
            eq(userDataIngests.origin, origin),
            eq(userDataIngests.batchId, envelope.batch.id),
          ),
        )
        .get();
      if (earlier?.response) {
        return { response: earlier.response as unknown as IngestResponse, repeated: true };
      }

      upsertSource(tx, source, envelope, receivedAt);
      const ingestId = tx
        .insert(userDataIngests)
        .values({
          source: source.source,
          origin,
          batchId: envelope.batch.id,
          trigger: envelope.batch.trigger ?? null,
          receivedAt,
          itemCount: envelope.upserts.length + envelope.deletes.length,
          status: "ok",
        })
        .returning({ id: userDataIngests.id })
        .get().id;

      const counts = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
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
        const outcome = writePoint(tx, source.source, origin, item, ingestId, receivedAt);
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
          .delete(userDataPoints)
          .where(
            and(
              eq(userDataPoints.source, source.source),
              eq(userDataPoints.origin, origin),
              eq(userDataPoints.dedupeKey, checked.item.key),
            ),
          )
          .returning({ type: userDataPoints.type })
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
        syncedThrough.set(entry.type, Date.parse(entry.syncedThrough));
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
      tx.update(userDataIngests)
        .set({
          ...counts,
          rejected: rejected.length,
          rangeStartAt: rangeStart ?? null,
          rangeEndAt: rangeEnd ?? null,
          durationMs: Date.now() - receivedAt,
          status,
          response: response as unknown as Record<string, unknown>,
        })
        .where(eq(userDataIngests.id, ingestId))
        .run();
      tx.update(userDataSources)
        .set({ lastSyncAt: receivedAt, lastResult: status, lastErrorCode: null })
        .where(sourceRow(source.source, origin))
        .run();
      tx.delete(userDataIngests)
        .where(lt(userDataIngests.receivedAt, receivedAt - INGEST_LOG_DAYS * 86_400_000))
        .run();
      return { response, repeated: false };
    });
  }

  /** Every source and origin with its types, the active origins first. */
  catalog(): CatalogSource[] {
    const sources = this.db
      .select()
      .from(userDataSources)
      .orderBy(desc(userDataSources.lastSyncAt))
      .all();
    const types = this.db.select().from(userDataTypes).orderBy(asc(userDataTypes.type)).all();
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

  /** The origin a query reads: the active one, else the one that synced last. */
  currentOrigin(source: string): string | undefined {
    const rows = this.db
      .select({ origin: userDataSources.origin, state: userDataSources.state })
      .from(userDataSources)
      .where(eq(userDataSources.source, source))
      .orderBy(desc(userDataSources.lastSyncAt))
      .all();
    return (rows.find((row) => row.state === "active") ?? rows[0])?.origin;
  }

  /** The origin's synced-through time per type. */
  syncedThrough(source: string, origin: string): Map<string, number> {
    const rows = this.db
      .select({ type: userDataTypes.type, at: userDataTypes.syncedThroughAt })
      .from(userDataTypes)
      .where(and(eq(userDataTypes.source, source), eq(userDataTypes.origin, origin)))
      .all();
    return new Map(rows.flatMap((row) => (row.at === null ? [] : [[row.type, row.at]])));
  }

  /** An origin's points of one type that start in `[from, to)`, oldest first. */
  points(
    source: string,
    origin: string,
    type: string,
    range: {
      from: number;
      to: number;
      resolution?: Resolution;
      after?: { startAt: number; id: number };
      limit?: number;
    },
  ): StoredPoint[] {
    const after = range.after;
    const query = this.db
      .select({
        id: userDataPoints.id,
        type: userDataPoints.type,
        shape: userDataPoints.shape,
        resolution: userDataPoints.resolution,
        startAt: userDataPoints.startAt,
        endAt: userDataPoints.endAt,
        tz: userDataPoints.tz,
        value: userDataPoints.value,
        fields: userDataPoints.fields,
        metadata: userDataPoints.metadata,
      })
      .from(userDataPoints)
      .where(
        and(
          eq(userDataPoints.source, source),
          eq(userDataPoints.type, type),
          range.resolution ? eq(userDataPoints.resolution, range.resolution) : undefined,
          eq(userDataPoints.origin, origin),
          gte(userDataPoints.startAt, range.from),
          lt(userDataPoints.startAt, range.to),
          after
            ? or(
                gt(userDataPoints.startAt, after.startAt),
                and(eq(userDataPoints.startAt, after.startAt), gt(userDataPoints.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(userDataPoints.startAt), asc(userDataPoints.id));
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
      .update(userDataSources)
      .set({ state })
      .where(sourceRow(source, origin))
      .returning({ origin: userDataSources.origin })
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
      const known = tx.select().from(userDataSources).where(sourceRow(source, origin)).get();
      if (!known) return undefined;
      const deletedPoints =
        tx
          .select({ n: count() })
          .from(userDataPoints)
          .where(and(eq(userDataPoints.source, source), eq(userDataPoints.origin, origin)))
          .get()?.n ?? 0;
      tx.delete(userDataPoints)
        .where(and(eq(userDataPoints.source, source), eq(userDataPoints.origin, origin)))
        .run();
      tx.delete(userDataTypes)
        .where(and(eq(userDataTypes.source, source), eq(userDataTypes.origin, origin)))
        .run();
      tx.update(userDataSources).set({ state: "off" }).where(sourceRow(source, origin)).run();
      tx.insert(userDataIngests)
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
      .from(userDataIngests)
      .where(eq(userDataIngests.source, source))
      .orderBy(desc(userDataIngests.receivedAt), desc(userDataIngests.id))
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
  return and(eq(userDataSources.source, source), eq(userDataSources.origin, origin));
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
  tx.insert(userDataSources)
    .values({
      source: source.source,
      origin: envelope.origin.id,
      firstSyncAt: receivedAt,
      ...refreshed,
    })
    .onConflictDoUpdate({
      target: [userDataSources.source, userDataSources.origin],
      set: {
        ...refreshed,
        firstSyncAt: sql`coalesce(${userDataSources.firstSyncAt}, ${receivedAt})`,
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
): "inserted" | "updated" | "unchanged" | "type_cap" {
  const existing = tx
    .select({ id: userDataPoints.id, hash: userDataPoints.contentHash })
    .from(userDataPoints)
    .where(
      and(
        eq(userDataPoints.source, source),
        eq(userDataPoints.origin, origin),
        eq(userDataPoints.dedupeKey, item.key),
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
    tx.update(userDataPoints).set(values).where(eq(userDataPoints.id, existing.id)).run();
    return "updated";
  }
  if (item.shape !== "bucket") {
    const stored = tx
      .select({ n: count() })
      .from(userDataPoints)
      .where(
        and(
          eq(userDataPoints.source, source),
          eq(userDataPoints.type, item.type),
          eq(userDataPoints.origin, origin),
        ),
      )
      .get();
    if ((stored?.n ?? 0) >= MAX_POINTS_PER_TYPE) return "type_cap";
  }
  tx.insert(userDataPoints)
    .values({ source, origin, dedupeKey: item.key, ...values })
    .run();
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
      earliest: min(userDataPoints.startAt),
      latest: max(userDataPoints.endAt),
    })
    .from(userDataPoints)
    .where(
      and(
        eq(userDataPoints.source, source.source),
        eq(userDataPoints.type, type),
        eq(userDataPoints.origin, origin),
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
    ...(syncedThroughAt !== undefined ? { syncedThroughAt } : {}),
  };
  tx.insert(userDataTypes)
    .values({ source: source.source, origin, type, ...values })
    .onConflictDoUpdate({
      target: [userDataTypes.source, userDataTypes.origin, userDataTypes.type],
      set: values,
    })
    .run();
}
