import { randomUUID } from "node:crypto";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { AppDbContext } from "@rome-os/app-runtime";
import { collections, traces } from "../schema.js";
import type { TraceEventDto, TraceSnapshot, TraceSummary } from "../../trace/types.js";

export type CollectionSource = "local-import" | "sample" | "bundle" | "remote-preset";

export interface CollectionView {
  id: string;
  title: string;
  description: string | null;
  source: CollectionSource | string;
  traceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TraceListItem {
  id: string;
  collectionId: string;
  title: string;
  description: string | null;
  capturedAt: string;
  summary: TraceSummary;
  metadata: Record<string, unknown>;
}

export interface TraceDetail extends TraceListItem {
  blocks: TraceEventDto[];
  snapshot: TraceSnapshot;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

export interface TraceInsert {
  id?: string;
  collectionId: string;
  title: string;
  description?: string | null;
  capturedAt: Date;
  blocks: TraceEventDto[];
  snapshot: TraceSnapshot;
  metadata?: Record<string, unknown>;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
}

function iso(date: Date): string {
  return date.toISOString();
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToCollection(row: {
  id: string;
  title: string;
  description: string | null;
  source: string;
  traceCount: number;
  createdAt: Date;
  updatedAt: Date;
}): CollectionView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    source: row.source,
    traceCount: row.traceCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function traceFallbackSummary(): TraceSummary {
  return { distinctApps: [], totalSteps: 0, invocationCounts: {} };
}

function rowToTraceListItem(row: typeof traces.$inferSelect): TraceListItem {
  return {
    id: row.id,
    collectionId: row.collectionId,
    title: row.title,
    description: row.description,
    capturedAt: iso(row.capturedAt),
    summary: parseJson(row.summaryJson, traceFallbackSummary()),
    metadata: parseJson(row.metadataJson, {}),
  };
}

function rowToTraceDetail(row: typeof traces.$inferSelect): TraceDetail {
  return {
    ...rowToTraceListItem(row),
    blocks: parseJson(row.blocksJson, []),
    snapshot: parseJson(row.snapshotJson, { segments: [], summary: traceFallbackSummary() }),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
  };
}

export class ShowcasesRepository {
  constructor(private readonly db: AppDbContext) {}

  listCollections(): CollectionView[] {
    const rows = this.db.connection
      .select({
        id: collections.id,
        title: collections.title,
        description: collections.description,
        source: collections.source,
        createdAt: collections.createdAt,
        updatedAt: collections.updatedAt,
        traceCount: sql<number>`cast(count(${traces.id}) as integer)`.mapWith(Number),
      })
      .from(collections)
      .leftJoin(traces, eq(traces.collectionId, collections.id))
      .groupBy(
        collections.id,
        collections.title,
        collections.description,
        collections.source,
        collections.createdAt,
        collections.updatedAt,
      )
      .orderBy(desc(collections.updatedAt))
      .all();
    return rows.map(rowToCollection);
  }

  getCollection(id: string): typeof collections.$inferSelect | null {
    return (
      this.db.connection.select().from(collections).where(eq(collections.id, id)).get() ?? null
    );
  }

  upsertCollection(input: {
    id?: string;
    title: string;
    description?: string | null;
    source: CollectionSource;
    now?: Date;
  }): string {
    const now = input.now ?? new Date();
    const id = input.id ?? randomUUID();
    this.db.connection
      .insert(collections)
      .values({
        id,
        title: input.title,
        description: input.description ?? null,
        source: input.source,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: collections.id,
        set: {
          title: input.title,
          description: input.description ?? null,
          source: input.source,
          updatedAt: now,
        },
      })
      .run();
    return id;
  }

  replaceCollectionTraces(collectionId: string): void {
    this.db.connection.delete(traces).where(eq(traces.collectionId, collectionId)).run();
  }

  upsertTrace(input: TraceInsert): string {
    const now = new Date();
    const id = input.id ?? randomUUID();
    const values = {
      id,
      collectionId: input.collectionId,
      title: input.title,
      description: input.description ?? null,
      capturedAt: input.capturedAt,
      blocksJson: JSON.stringify(input.blocks),
      snapshotJson: JSON.stringify(input.snapshot),
      summaryJson: JSON.stringify(input.snapshot.summary),
      metadataJson: JSON.stringify(input.metadata ?? {}),
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheWriteTokens: input.cacheWriteTokens ?? null,
      costUsd: input.costUsd ?? null,
      createdAt: now,
      updatedAt: now,
    } satisfies typeof traces.$inferInsert;

    this.db.connection
      .insert(traces)
      .values(values)
      .onConflictDoUpdate({
        target: traces.id,
        set: {
          collectionId: values.collectionId,
          title: values.title,
          description: values.description,
          capturedAt: values.capturedAt,
          blocksJson: values.blocksJson,
          snapshotJson: values.snapshotJson,
          summaryJson: values.summaryJson,
          metadataJson: values.metadataJson,
          inputTokens: values.inputTokens,
          outputTokens: values.outputTokens,
          cacheReadTokens: values.cacheReadTokens,
          cacheWriteTokens: values.cacheWriteTokens,
          costUsd: values.costUsd,
          updatedAt: now,
        },
      })
      .run();
    this.touchCollection(input.collectionId, now);
    return id;
  }

  listTraces(collectionId?: string): TraceListItem[] {
    const base = this.db.connection.select().from(traces);
    const rows = collectionId
      ? base.where(eq(traces.collectionId, collectionId)).orderBy(desc(traces.capturedAt)).all()
      : base.orderBy(desc(traces.capturedAt)).all();
    return rows.map(rowToTraceListItem);
  }

  getTrace(id: string): TraceDetail | null {
    const row = this.db.connection.select().from(traces).where(eq(traces.id, id)).get();
    return row ? rowToTraceDetail(row) : null;
  }

  listCollectionTraceDetails(collectionId: string): TraceDetail[] {
    return this.db.connection
      .select()
      .from(traces)
      .where(eq(traces.collectionId, collectionId))
      .orderBy(asc(traces.capturedAt))
      .all()
      .map(rowToTraceDetail);
  }

  getTraces(ids: string[]): TraceDetail[] {
    if (ids.length === 0) return [];
    return this.db.connection
      .select()
      .from(traces)
      .where(inArray(traces.id, ids))
      .orderBy(asc(traces.capturedAt))
      .all()
      .map(rowToTraceDetail);
  }

  deleteCollection(id: string): void {
    this.db.connection.delete(traces).where(eq(traces.collectionId, id)).run();
    this.db.connection.delete(collections).where(eq(collections.id, id)).run();
  }

  private touchCollection(id: string, updatedAt: Date): void {
    this.db.connection.update(collections).set({ updatedAt }).where(eq(collections.id, id)).run();
  }
}
