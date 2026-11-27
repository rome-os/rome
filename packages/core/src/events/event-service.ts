import type {
  EventCatalogEntry,
  EventCatalogReader,
  EventCatalogSearchOptions,
  EventCatalogSearchResult,
  EventPublisher,
} from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";
import type { EventBus } from "./event-bus.js";
import { inferPayloadSchema, searchCatalogEntries, type EventCatalog } from "../event-catalog.js";
import { matchToFilter, type EventSources, type RunEnsureAction } from "./event-sources.js";

const log = createLogger("event-service");

/**
 * App-facing coordinator over the event subsystem. Publishing a domain event
 * delivers it on the data-plane {@link EventBus} *and* declares its type in the
 * control-plane {@link EventCatalog}; searching reads the catalog.
 *
 * The bus and catalog stay decoupled from each other — the bus is pure delivery
 * and the catalog pure registry. This service is the single place that knows
 * both, so the "publishing also declares the type" rule lives here rather than
 * leaking into either domain object. An action receives it (in the main
 * process) or an {@link EventPublisher}/{@link EventCatalogReader} proxy (in a
 * worker) and cannot tell the difference.
 */
export class EventService implements EventPublisher, EventCatalogReader {
  constructor(
    private readonly bus: EventBus,
    private readonly catalog: EventCatalog,
    /** Types apps declare in app.yaml, merged into search results, and the
     * action runner a `match` search probes them with. */
    private readonly declared?: { sources: EventSources; run: RunEnsureAction },
  ) {}

  async publish(event: {
    name: string;
    source: string;
    payload?: Record<string, unknown>;
  }): Promise<{ accepted: true }> {
    this.bus.publish({
      name: event.name,
      source: event.source,
      payload: event.payload ?? {},
      emittedAt: new Date().toISOString(),
    });
    // A producer declares a watchable event type by emitting it: record it so
    // routine creation can discover what's subscribable. A namespace collision
    // (two sources claiming one type) must not break the publish — log and move
    // on; publishing is the data plane and must never fail on catalog drift.
    try {
      const payloadSchema = inferPayloadSchema(event.payload);
      this.catalog.register({
        eventType: event.name,
        appId: event.source,
        ...(payloadSchema ? { payloadSchema, schemaOrigin: "observed" as const } : {}),
      });
    } catch (err) {
      log.warn("event-catalog registration skipped", {
        eventType: event.name,
        appId: event.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { accepted: true };
  }

  /** Observed and declared types together. An observed type keeps its
   * observed schema and gains the declaration's `subscribable` / `keys`. With
   * `match`, each subscribable result also reports `active`, asked of the
   * producer; without it no provider is called. */
  async search(
    query: string,
    limit: number,
    options: EventCatalogSearchOptions = {},
  ): Promise<EventCatalogSearchResult> {
    if (!this.declared) return this.catalog.search(query, limit);
    const { sources, run } = this.declared;

    const merged = new Map<string, EventCatalogEntry>();
    for (const entry of this.catalog.list()) {
      const source = sources.sourceFor(entry.eventType);
      merged.set(
        entry.eventType,
        source ? { ...entry, subscribable: true, keys: source.keys } : { ...entry },
      );
    }
    for (const entry of sources.declaredEntries()) {
      if (!merged.has(entry.eventType)) merged.set(entry.eventType, entry);
    }
    const result = searchCatalogEntries([...merged.values()], query, limit);
    if (!options.match) return result;

    // One probe at a time: each runs an action, and `limit` bounds the count.
    // The first failure (not connected, no access to the target) would repeat
    // for every type, so it stops further probes.
    const filter = matchToFilter(options.match);
    let matchError: string | undefined;
    const entries: EventCatalogEntry[] = [];
    for (const entry of result.entries) {
      if (!entry.subscribable || matchError) {
        entries.push(entry);
        continue;
      }
      const probe = await sources.probe(entry.eventType, filter, run);
      if (probe.ok) {
        entries.push({ ...entry, active: probe.active });
        continue;
      }
      log.info("event source probe failed", { eventType: entry.eventType, error: probe.error });
      matchError ??= probe.error;
      entries.push(entry);
    }
    return { entries, total: result.total, ...(matchError ? { matchError } : {}) };
  }
}
