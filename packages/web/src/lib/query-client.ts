import { QueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * Edits every cached query under `queryKey` with `update`, so that no read
 * already on its way overwrites the edit: each is cancelled first and, once
 * edited, read again, now after the change it would have missed.
 */
export async function patchQueries<T>(
  client: QueryClient,
  queryKey: QueryKey,
  update: (data: T | undefined) => T | undefined,
): Promise<void> {
  const inFlight = client
    .getQueryCache()
    .findAll({ queryKey })
    .filter((query) => query.state.fetchStatus === "fetching")
    .map((query) => query.queryKey);
  await client.cancelQueries({ queryKey });
  client.setQueriesData<T>({ queryKey }, update);
  for (const key of inFlight) void client.invalidateQueries({ queryKey: key, exact: true });
}

/**
 * For a query that live events keep current: an event or a reconnect
 * invalidates it, which refetches it at once. Mounting it again, such as on
 * every chat switch, reuses the cache for half a minute. The tab coming back
 * into view does not refetch it: React Query reads focus from
 * `visibilitychange`, so a tab flipping between hidden and visible would
 * refetch it on every flip.
 */
export const LIVE_QUERY_OPTIONS = {
  staleTime: 30_000,
  refetchOnWindowFocus: false,
} as const;

// One client for the whole dashboard. Defaults tuned for an operator console:
// data is fresh for `staleTime`, so rapid remounts/refocuses within that window
// reuse cache instead of hammering the backend; once stale, regaining window
// focus refetches (the resync point for changes made elsewhere). Mutations
// invalidate the relevant queryKey to pull server truth rather than
// hand-patching local state. Queries that live events keep current use
// LIVE_QUERY_OPTIONS instead.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});
