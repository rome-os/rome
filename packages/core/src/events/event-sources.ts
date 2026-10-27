import type { EventCatalogEntry, EventFilterCondition } from "@rome-os/app-runtime";
import { matchesSource } from "../routines/event-bus-trigger-provider.js";
import type { RomeAppEventSource } from "../apps/types.js";
import { createLogger } from "../logger.js";

const log = createLogger("event-sources");

/** An `eventSources` entry from an enabled app's app.yaml, tagged with the app. */
export interface DeclaredEventSource extends RomeAppEventSource {
  appId: string;
}

/** Runs the source's `ensureAction`. Injected so the caller decides who the
 * call is attributed to (the agent turn for `defer`, the system for a
 * catalog lookup). Throws, or returns an `error` status, on failure. */
export type RunEnsureAction = (
  actionName: string,
  args: Record<string, unknown>,
) => Promise<{ status: string; data?: unknown; error?: string }>;

/** Whether a wait found its subscription in place or created it. */
export type Subscription = "existing" | "created";

export type EventWaitResult =
  | { ok: true; subscription?: Subscription; warning?: string }
  | { ok: false; error: string };

export interface EventSourcesDeps {
  /** Declared sources of every enabled app, read live on each call so an
   * install or disable takes effect without a restart. */
  listSources: () => DeclaredEventSource[];
  /** Whether a producer has emitted this type since boot. */
  isKnownEventType: (eventName: string) => boolean;
}

/**
 * Event sources that apps declare in app.yaml. Core never knows a provider:
 * it finds the source whose `events` glob matches an event name, checks the
 * filter names a subscription target (`keys`), and calls the source's
 * `ensureAction` to check or create the subscription.
 */
export class EventSources {
  /** Tail of each source's queue of subscribing calls, keyed by source. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: EventSourcesDeps) {}

  /** The source that declares `eventName`, if any. The first match wins. */
  sourceFor(eventName: string): DeclaredEventSource | undefined {
    const matches = this.deps.listSources().filter((s) => matchesSource(s.events, eventName));
    if (matches.length > 1) {
      log.warn("several apps declare one event; using the first", {
        eventName,
        appIds: matches.map((s) => s.appId),
      });
    }
    return matches[0];
  }

  /** One catalog entry per declared type, so a type is discoverable before
   * its first emission. */
  declaredEntries(): EventCatalogEntry[] {
    return this.deps.listSources().flatMap((source) =>
      source.types.map((type) => ({
        eventType: source.events.replaceAll("*", type),
        appId: source.appId,
        subscribable: true,
        keys: source.keys,
      })),
    );
  }

  /**
   * Make sure an event wait can fire. A declared event subscribes at the
   * provider (or confirms the subscription exists), and the wait fails when it
   * can't. An undeclared event is accepted; when nothing has emitted it since
   * boot the result carries a warning, because the catalog starts empty on
   * every boot and can't tell a typo from an event that just hasn't happened.
   */
  async prepareWait(
    eventName: string,
    filter: EventFilterCondition[],
    run: RunEnsureAction,
  ): Promise<EventWaitResult> {
    const source = this.sourceFor(eventName);
    if (!source) {
      if (this.deps.isKnownEventType(eventName)) return { ok: true };
      return {
        ok: true,
        warning:
          `Nothing has emitted "${eventName}" since Rome started, and no app declares it. ` +
          "The wait is set; if the name may be wrong, check it with search_event_catalog.",
      };
    }
    // One subscribing call per source at a time: a provider subscription is
    // often a read-modify-write of shared state (one webhook per repo), and
    // two at once can drop each other's event.
    const result = await this.serialized(`${source.appId}:${source.ensureAction}`, () =>
      this.ensure(source, eventName, filter, run, false),
    );
    if (!result.ok) return result;
    return { ok: true, subscription: result.subscription as Subscription };
  }

  /** Ask the source whether it already delivers `eventName` for the target in
   * `filter`, without subscribing. */
  async probe(
    eventName: string,
    filter: EventFilterCondition[],
    run: RunEnsureAction,
  ): Promise<{ ok: true; active: boolean } | { ok: false; error: string }> {
    const source = this.sourceFor(eventName);
    if (!source) return { ok: false, error: `No app declares "${eventName}"` };
    const result = await this.ensure(source, eventName, filter, run, true);
    if (!result.ok) return result;
    return { ok: true, active: result.subscription === "active" };
  }

  private serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(task);
    const tail = next.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return next;
  }

  private async ensure(
    source: DeclaredEventSource,
    eventName: string,
    filter: EventFilterCondition[],
    run: RunEnsureAction,
    dryRun: boolean,
  ): Promise<{ ok: true; subscription: string } | { ok: false; error: string }> {
    const missing = missingKeys(source.keys, filter);
    if (missing) return { ok: false, error: `${eventName} needs ${missing}` };

    const expected = dryRun ? ["active", "inactive"] : ["existing", "created"];
    try {
      const result = await run(source.ensureAction, { eventName, filter, dryRun });
      if (result.status === "error") {
        return { ok: false, error: result.error ?? `${source.ensureAction} failed` };
      }
      const subscription = (result.data as { subscription?: unknown } | undefined)?.subscription;
      if (result.status !== "ok" || typeof subscription !== "string") {
        return { ok: false, error: `${source.ensureAction} returned no subscription state` };
      }
      if (!expected.includes(subscription)) {
        return {
          ok: false,
          error: `${source.ensureAction} returned subscription "${subscription}", expected ${expected.join(" or ")}`,
        };
      }
      return { ok: true, subscription };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("ensure action failed", { eventName, action: source.ensureAction, error: message });
      return { ok: false, error: `${source.ensureAction} failed: ${message}` };
    }
  }
}

/** Null when `filter` covers every field of one key set (or there are no
 * keys), else a readable description of what to add. */
function missingKeys(keys: string[][], filter: EventFilterCondition[]): string | null {
  if (keys.length === 0) return null;
  const fields = new Set(filter.map((c) => c.field));
  if (keys.some((set) => set.every((field) => fields.has(field)))) return null;
  return `a filter on ${keys.map((set) => set.join(" and ")).join(" or ")}`;
}

/** Turn a `match` object into equality filter conditions. */
export function matchToFilter(match: Record<string, string>): EventFilterCondition[] {
  return Object.entries(match).map(([field, equals]) => ({ field, equals }));
}
