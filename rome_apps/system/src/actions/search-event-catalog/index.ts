import { createAppLogger, defineAction, z } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  AppActionRuntimeDeps,
  EventCatalogEntry,
  EventCatalogReader,
} from "@rome-os/app-runtime";

const log = createAppLogger("search-event-catalog");

export interface SearchEventCatalogDeps {
  /** The catalog read side: the real `EventService` in the main process, an
   * `EventCatalogProxy` (RPC to main) in a worker. Injected per process. */
  eventCatalog: EventCatalogReader;
}

export const searchEventCatalogInputSchema = z.object({
  query: z
    .string()
    .describe(
      "Keywords describing the event to watch (e.g. 'gmail new email', 'stripe payment'). Token-OR matched against event type names; leave empty to browse.",
    )
    .default(""),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .describe("Max number of matches to return.")
    .default(10),
  match: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Optional payload field values naming a subscription target, e.g. {"repository.full_name": "acme/widgets"}. Each subscribable result then reports `active`: whether the producer already delivers it there. Asks the provider, so leave it out when you only need names and fields.',
    ),
});

export type SearchEventCatalogInput = z.infer<typeof searchEventCatalogInputSchema>;

/** Discover the event types an event-bus routine can watch, ranked by relevance
 * to `query` and capped at `limit` so a large catalog never floods the agent's
 * context. Reads the live control-plane catalog in the main process
 * via worker RPC: the types producer apps have emitted, plus the types apps
 * declare under `eventSources` in app.yaml (`subscribable`).
 * `total` is the full match count, so the caller can tell when to narrow. */
export async function searchEventCatalog(
  input: SearchEventCatalogInput,
  deps: SearchEventCatalogDeps,
): Promise<{ events: EventCatalogEntry[]; total: number; matchError?: string }> {
  const { entries, total, matchError } = await deps.eventCatalog.search(
    input.query,
    input.limit,
    input.match ? { match: input.match } : {},
  );
  log.info("searched event catalog", { query: input.query, returned: entries.length, total });
  return { events: entries, total, ...(matchError ? { matchError } : {}) };
}

export function createSearchEventCatalogAction(
  config: ActionConfig,
  deps: SearchEventCatalogDeps,
): Action {
  return defineAction({
    config,
    schema: searchEventCatalogInputSchema,
    execute: async (input) => {
      const result = await searchEventCatalog(input, deps);
      return { status: "ok", data: result };
    },
  });
}

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<SearchEventCatalogDeps>,
): Action {
  return createSearchEventCatalogAction(config, deps);
}
