import { z } from "zod";
import type { JSONSchema } from "zod/v4/core";
import type { EventCatalogEntry } from "@rome-os/app-runtime";
import { createLogger } from "./logger.js";

const log = createLogger("event-catalog");

/** Runtime validator for the catalog contract. `satisfies` pins it to the
 * published `EventCatalogEntry` shape so the schema and the SDK type can't drift.
 * The namespace prefix on `eventType` is the producing app, which keeps two apps
 * from claiming the same type by accident (e.g. "connector:GMAIL_NEW_MESSAGE").
 * `payloadSchema` is structurally checked rather than deep-validated — a full
 * JSON Schema meta-validator is overkill at this boundary; the field only ever
 * comes from {@link inferPayloadSchema} or (later) a producer declaration. */
export const catalogEntrySchema = z.object({
  eventType: z.string(),
  appId: z.string(),
  payloadSchema: z
    .custom<JSONSchema.ObjectSchema>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { type?: unknown }).type === "object",
    )
    .optional(),
  schemaOrigin: z.enum(["observed", "declared"]).optional(),
  subscribable: z.boolean().optional(),
  keys: z.array(z.array(z.string())).optional(),
  active: z.boolean().optional(),
}) satisfies z.ZodType<EventCatalogEntry>;

export type CatalogEntry = EventCatalogEntry;

/** How deep {@link inferPayloadSchema} descends into nested objects. Routine
 * `trigger.filter` dot-paths can read nested fields, so nesting is worth
 * surfacing — but a pathological payload must not balloon the catalog, so
 * below the cap a nested object is reported as a bare `{ type: "object" }`. */
const MAX_INFER_DEPTH = 3;

function inferValueSchema(value: unknown, depth: number): JSONSchema.BaseSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array" };
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object":
      return depth >= MAX_INFER_DEPTH
        ? { type: "object" }
        : inferObjectSchema(value as Record<string, unknown>, depth + 1);
    default:
      // Non-JSON value (function, symbol, bigint, undefined) — emit the
      // unconstrained schema rather than claim a type the wire can't carry.
      return {};
  }
}

function inferObjectSchema(obj: Record<string, unknown>, depth: number): JSONSchema.ObjectSchema {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.keys(obj).map((key) => [key, inferValueSchema(obj[key], depth)]),
    ),
  };
}

/** Infer a JSON Schema from an event payload, for discovery (see
 * {@link EventCatalogEntry.payloadSchema}). Inferred from one sample, so it
 * deliberately carries no `required` — a single emission can't establish which
 * fields are always present. Returns undefined for an empty/absent payload so
 * a payload-less emission never overwrites a schema captured from an earlier,
 * richer one. */
export function inferPayloadSchema(
  payload: Record<string, unknown> | undefined,
): JSONSchema.ObjectSchema | undefined {
  if (!payload || Object.keys(payload).length === 0) return undefined;
  return inferObjectSchema(payload, 1);
}

/**
 * In-memory registry of the event types producer apps can *currently* emit.
 * Control plane only — it records what exists, it does not deliver
 * events. Entries are live-only: an event type is present here iff a producer
 * can emit it right now, so the registry is rebuilt from producer registrations
 * on every boot and carries no persistence.
 */
export class EventCatalog {
  private entries = new Map<string, CatalogEntry>();

  /** A producer declares it can now emit `entry.eventType`. Idempotent for the
   * same owner. Throws if a different app already owns the type so a namespace
   * collision fails loudly instead of one producer silently shadowing another. */
  register(entry: CatalogEntry): void {
    const existing = this.entries.get(entry.eventType);
    if (existing && existing.appId !== entry.appId) {
      throw new Error(
        `event type "${entry.eventType}" is already registered by app "${existing.appId}"`,
      );
    }
    // Keep the most authoritative payload schema: a declared schema is never
    // overwritten by an observed one, an observed schema refreshes on each
    // non-empty emission, and a schema-less re-register must not wipe a schema
    // captured earlier — otherwise discovery regresses to name-only.
    const acceptIncoming =
      entry.payloadSchema !== undefined &&
      !(existing?.schemaOrigin === "declared" && entry.schemaOrigin !== "declared");
    const payloadSchema = acceptIncoming ? entry.payloadSchema : existing?.payloadSchema;
    const schemaOrigin = acceptIncoming ? entry.schemaOrigin : existing?.schemaOrigin;
    this.entries.set(entry.eventType, {
      eventType: entry.eventType,
      appId: entry.appId,
      ...(payloadSchema !== undefined ? { payloadSchema } : {}),
      ...(schemaOrigin !== undefined ? { schemaOrigin } : {}),
    });
    log.info("event type registered", {
      eventType: entry.eventType,
      appId: entry.appId,
    });
  }

  /** A producer declares it can no longer emit `eventType`. No-op when absent.
   * Throws if the type is owned by a different app so one producer can't drop
   * another's entry. */
  unregister(appId: string, eventType: string): void {
    const existing = this.entries.get(eventType);
    if (!existing) return;
    if (existing.appId !== appId) {
      throw new Error(
        `app "${appId}" cannot unregister event type "${eventType}" owned by "${existing.appId}"`,
      );
    }
    this.entries.delete(eventType);
    log.info("event type unregistered", { eventType, appId });
  }

  /** Every currently-emittable event type. Consumed by the dashboard's
   * event-catalog endpoint, which renders the full list. */
  list(): CatalogEntry[] {
    return [...this.entries.values()];
  }

  /** Find emittable event types matching `query`, best matches first, capped at
   * `limit`. The routine-creation agent uses this instead of `list()` so a large
   * catalog never floods its context. Matching is token-OR: `query` is split on
   * whitespace and an entry matches if its "eventType appId" text contains any
   * token (case-insensitive); results rank by how many distinct tokens they hit,
   * ties broken by the shorter eventType (more specific wins). A blank query
   * browses — it returns the first `limit` entries. `total` is the full match
   * count before truncation, so the caller can tell when to narrow the query. */
  search(query: string, limit: number): { entries: CatalogEntry[]; total: number } {
    return searchCatalogEntries([...this.entries.values()], query, limit);
  }

  /** Look up a single entry; undefined when no producer can currently emit it.
   * Used to fail-closed when a routine binds to an event-bus trigger. Returns a
   * read-only view — the result aliases the stored entry, so mutating it would
   * corrupt the catalog. */
  get(eventType: string): Readonly<CatalogEntry> | undefined {
    return this.entries.get(eventType);
  }
}

/** The ranking behind {@link EventCatalog.search}, over any entry list, so
 * declared types merged in at read time rank the same way. */
export function searchCatalogEntries(
  entries: readonly CatalogEntry[],
  query: string,
  limit: number,
): { entries: CatalogEntry[]; total: number } {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = entries
    .map((entry) => {
      const haystack = `${entry.eventType} ${entry.appId}`.toLowerCase();
      const score = tokens.filter((token) => haystack.includes(token)).length;
      return { entry, score };
    })
    .filter(({ score }) => tokens.length === 0 || score > 0);
  scored.sort((a, b) => b.score - a.score || a.entry.eventType.length - b.entry.eventType.length);
  return {
    entries: scored.slice(0, Math.max(0, limit)).map(({ entry }) => ({ ...entry })),
    total: scored.length,
  };
}
