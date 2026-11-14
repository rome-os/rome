import { type QueryClient, useQuery } from "@tanstack/react-query";
import type {
  ConciergeConnectorDto,
  ConciergeConnectorsResponse,
  ConciergeFollowDto,
} from "@rome/api-types/concierge";
import { fetchJson } from "@/lib/fetch-json";

const CONCIERGE_CONNECTORS_QUERY_KEY = ["concierge-connectors"] as const;

/**
 * Reading the list asks every service whether it works, about a second when
 * nothing is cached on the server. A minute is fresh enough to dim a follow
 * row; a connect card that just connected reads again (`refreshConciergeConnectors`).
 */
const CONCIERGE_CONNECTORS_STALE_MS = 60_000;

export const conciergeConnectorsQuery = {
  queryKey: CONCIERGE_CONNECTORS_QUERY_KEY,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    fetchJson<ConciergeConnectorsResponse>("/api/concierge/connectors", { signal, fallback: "" }),
  staleTime: CONCIERGE_CONNECTORS_STALE_MS,
  refetchOnWindowFocus: false,
} as const;

/** The Concierge's connector list, one cached read shared by every caller. */
export function useConciergeConnectors() {
  return useQuery(conciergeConnectorsQuery);
}

export function refreshConciergeConnectors(client: QueryClient) {
  return client.invalidateQueries({ queryKey: CONCIERGE_CONNECTORS_QUERY_KEY });
}

/** `service`'s entry in the list, or undefined while the list is not read or has none. */
export function connectorOf(
  list: ConciergeConnectorsResponse | undefined,
  service: string,
): ConciergeConnectorDto | undefined {
  return list?.connectors.find((entry) => entry.service === service);
}

/**
 * A follow row's state. The task list says it (`off`, `active`, or, from
 * sources Rome read moments before, `unavailable`); the connector list only
 * adds `unavailable`, when it shows the follow's service cannot deliver it.
 * It never turns a follow on or off: its snapshot can be older than the list.
 */
export function followStateWith(
  list: ConciergeConnectorsResponse | undefined,
  follow: { source: string; target: string; state: ConciergeFollowDto["state"] },
): ConciergeFollowDto["state"] {
  if (follow.state !== "active" || !list) return follow.state;
  const connector = connectorOf(list, follow.source);
  // A service the snapshot does not list may be one connected since it was read.
  if (!connector) return follow.state;
  const watch = connector.capabilities.watch;
  const listed = watch.follows?.find((f) => f.target === follow.target);
  const ready = watch.state === "unlocked" && !watch.degradation;
  return listed?.state === "unavailable" || !ready ? "unavailable" : follow.state;
}
