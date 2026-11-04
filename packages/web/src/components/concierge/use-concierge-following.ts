import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { ConciergeConnectorsResponse } from "@rome/api-types/concierge";
import { CONCIERGE_CONNECTORS_TOPIC } from "@rome/api-types/live-events";
import { type LiveTopic, useLiveEvents } from "@/hooks/use-live-events";
import { fetchJson } from "@/lib/fetch-json";

const CONCIERGE_CONNECTORS_QUERY_KEY = ["concierge-connectors"] as const;

const conciergeConnectorsTopic: LiveTopic = {
  topic: CONCIERGE_CONNECTORS_TOPIC,
  sseUrl: "/api/concierge/connectors/events",
};

/**
 * The Concierge's connectors and what it follows through them: the same
 * structure the Concierge reads. A change from chat sends `connectors_changed`,
 * and the list is read again.
 */
export function useConciergeFollowing() {
  const query = useQuery({
    queryKey: CONCIERGE_CONNECTORS_QUERY_KEY,
    staleTime: 0,
    queryFn: ({ signal }) =>
      fetchJson<ConciergeConnectorsResponse>("/api/concierge/connectors", {
        signal,
        fallback: "",
      }),
  });
  const refetch = query.refetch;
  useLiveEvents(
    conciergeConnectorsTopic,
    { connectors_changed: { schema: z.object({}).passthrough(), fn: () => void refetch() } },
    // Events missed while disconnected are gone, so read the list again.
    { onReconnect: () => void refetch() },
  );
  const followed = (query.data?.connectors ?? []).filter(
    (connector) => (connector.watch?.follows?.length ?? 0) > 0,
  );
  const followCount = followed.reduce(
    (count, connector) => count + (connector.watch?.follows.length ?? 0),
    0,
  );
  return { data: query.data, loaded: query.isFetched, followed, followCount };
}
