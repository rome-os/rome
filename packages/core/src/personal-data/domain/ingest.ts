// The ingest contract: the envelope a device sends and the checks each item
// passes. Contract: docs/personal-data.md#ingest.

import { createHash } from "node:crypto";
import { z } from "zod";
import { isValidTimeZone } from "../../lib/timezone.js";
import { type Resolution, type Shape, type SourceSpec, typeSpec } from "./source.js";

/** At most this many upserts and deletes together in one request. */
export const MAX_ITEMS_PER_BATCH = 2000;
/** At most this many bytes of JSON in one request. */
export const MAX_BATCH_BYTES = 1024 * 1024;
/** At most this many bytes of JSON in one item. */
export const MAX_ITEM_BYTES = 4096;
/** At most this many sample or record rows per type and origin. Buckets are
 *  bounded by time and have no cap. */
export const MAX_POINTS_PER_TYPE = 50_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The earliest reading the store takes, so a wrong clock cannot fill it with
 *  impossible years. */
const EARLIEST_AT = Date.UTC(2000, 0, 1);

export type RejectCode =
  | "unknown_type"
  | "bad_unit"
  | "bad_range"
  | "type_cap"
  | "too_large"
  | "bad_item";

export interface Rejected {
  /** The item's index: upserts first, then deletes after the last upsert. */
  index: number;
  key?: string;
  code: RejectCode;
}

const isoTime = z.string().refine((text) => !Number.isNaN(Date.parse(text)), "an ISO 8601 time");

/** The envelope. A request that fails it is refused whole with 400. */
export const ingestEnvelopeSchema = z.object({
  version: z.literal(1),
  source: z.string().min(1),
  origin: z.object({
    id: z.string().min(1).max(100),
    name: z.string().max(100).optional(),
    platform: z.string().max(40).optional(),
    appVersion: z.string().max(40).optional(),
  }),
  batch: z.object({
    id: z.string().min(1).max(100),
    trigger: z.string().max(40).optional(),
    index: z.number().int().nonnegative().optional(),
    last: z.boolean().optional(),
  }),
  types: z
    .array(z.object({ type: z.string().min(1), syncedThrough: isoTime.optional() }))
    .max(200)
    .default([]),
  // Items are checked one by one, so one bad item does not refuse the batch.
  upserts: z.array(z.unknown()).default([]),
  deletes: z.array(z.unknown()).default([]),
});

export type IngestEnvelope = z.infer<typeof ingestEnvelopeSchema>;

const itemSchema = z.object({
  key: z.string().min(1).max(200),
  type: z.string().min(1),
  shape: z.enum(["bucket", "sample", "record"]),
  resolution: z.enum(["hour", "day"]).nullish(),
  start: isoTime,
  end: isoTime,
  tz: z.string().min(1).max(64),
  value: z.number().finite().nullish(),
  unit: z.string().nullish(),
  fields: z.record(z.string().max(40), z.number().finite()).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const deleteSchema = z.object({ key: z.string().min(1).max(200) });

/** A reading as the store keeps it. */
export interface PointInput {
  key: string;
  type: string;
  shape: Shape;
  resolution: Resolution | null;
  startAt: number;
  endAt: number;
  tz: string;
  value: number | null;
  unit: string | null;
  fields: Record<string, number> | null;
  metadata: Record<string, string> | null;
  contentHash: string;
}

export type ItemCheck<T> = { ok: true; item: T } | { ok: false; code: RejectCode; key?: string };

/** Checks one upsert against the source's type table, or names why it is refused. */
export function checkUpsert(source: SourceSpec, raw: unknown, now: number): ItemCheck<PointInput> {
  if (JSON.stringify(raw ?? null).length > MAX_ITEM_BYTES) {
    return { ok: false, code: "too_large", key: keyOf(raw) };
  }
  const parsed = itemSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "bad_item", key: keyOf(raw) };
  const item = parsed.data;
  const reject = (code: RejectCode): ItemCheck<PointInput> => ({ ok: false, code, key: item.key });
  const spec = typeSpec(source, item.type);
  if (!spec) return reject("unknown_type");
  if (item.shape !== spec.shape) return reject("bad_item");
  const resolution = item.resolution ?? null;
  if (spec.shape === "bucket") {
    if (!resolution || !spec.resolutions?.includes(resolution)) return reject("bad_item");
  } else if (resolution !== null) {
    return reject("bad_item");
  }
  if (!isValidTimeZone(item.tz)) return reject("bad_item");
  const value = item.value ?? null;
  const unit = item.unit ?? null;
  if (value !== null && unit !== spec.unit) return reject("bad_unit");
  if (unit !== null && unit !== spec.unit) return reject("bad_unit");
  const startAt = Date.parse(item.start);
  const endAt = Date.parse(item.end);
  if (!rangeFits(spec.shape, resolution, startAt, endAt, now)) return reject("bad_range");
  const metadata = allowedMetadata(source, item.metadata ?? null);
  const fields = item.fields && Object.keys(item.fields).length > 0 ? item.fields : null;
  const stored = {
    type: item.type,
    shape: spec.shape,
    resolution,
    startAt,
    endAt,
    tz: item.tz,
    value,
    unit: value === null ? unit : spec.unit,
    fields,
    metadata,
  };
  return { ok: true, item: { key: item.key, ...stored, contentHash: contentHash(stored) } };
}

/** Checks one delete. */
export function checkDelete(raw: unknown): ItemCheck<{ key: string }> {
  const parsed = deleteSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, item: parsed.data }
    : { ok: false, code: "bad_item", key: keyOf(raw) };
}

function keyOf(raw: unknown): string | undefined {
  if (raw && typeof raw === "object" && "key" in raw) {
    const key = (raw as { key: unknown }).key;
    if (typeof key === "string" && key.length <= 200) return key;
  }
  return undefined;
}

function rangeFits(
  shape: Shape,
  resolution: Resolution | null,
  startAt: number,
  endAt: number,
  now: number,
): boolean {
  if (startAt < EARLIEST_AT || endAt > now + DAY_MS || endAt < startAt) return false;
  const length = endAt - startAt;
  if (resolution === "hour") return length === HOUR_MS;
  // A local day lasts 23 to 25 hours across a daylight saving change.
  if (resolution === "day") return length >= 22 * HOUR_MS && length <= 26 * HOUR_MS;
  if (shape === "record") return length > 0 && length <= 7 * DAY_MS;
  return length <= 7 * DAY_MS;
}

function allowedMetadata(
  source: SourceSpec,
  metadata: Record<string, unknown> | null,
): Record<string, string> | null {
  if (!metadata) return null;
  const kept: Record<string, string> = {};
  for (const key of source.metadataKeys) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) kept[key] = value.slice(0, 100);
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

function contentHash(stored: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(stored)).digest("hex").slice(0, 32);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
