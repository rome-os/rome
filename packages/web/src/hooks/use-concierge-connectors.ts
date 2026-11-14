import { type QueryClient, useQuery } from "@tanstack/react-query";
import type {
  ConciergeConnectorDto,
  ConciergeConnectorsResponse,
  ConciergeFollowDto,
} from "@rome/api-types/concierge";
import { fetchJson } from "@/lib/fetch-json";

export const CONCIERGE_CONNECTORS_QUERY_KEY = ["concierge-connectors"] as const;

/**
 * Reading the list asks every service whether it works, about a second when
 * nothing is cached on the server. A minute is fresh enough to dim a follow
 * row; a connect card that just connected reads again (`refreshConciergeConnectors`).
 */
export const CONCIERGE_CONNECTORS_STALE_MS = 60_000;

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
 * A follow row's state with whether its service can deliver now. The task list
 * says only `off` or `active`; a follow the list does not show as active
 * (its service not ready, a kind on not delivered, or the service gone) is
 * unavailable. Until the list is read the row keeps the task list's state.
 */
export function followStateWith(
  list: ConciergeConnectorsResponse | undefined,
  follow: { source: string; target: string; state: ConciergeFollowDto["state"] },
): ConciergeFollowDto["state"] {
  if (follow.state === "off" || !list) return follow.state;
  const listed = connectorOf(list, follow.source)?.capabilities.watch.follows?.find(
    (f) => f.target === follow.target,
  );
  return listed?.state ?? "unavailable";
}
