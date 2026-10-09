import { useQuery } from "@tanstack/react-query";
import type { PeopleList, PersonResource } from "@rome/api-types/people";
import { fetchJson } from "@/lib/fetch-json";

const PEOPLE_QUERY_KEY = ["people"] as const;

/**
 * Every curated person, as `GET /api/people` serves them. Never the stranger
 * sentinel — the route withholds it — and the guardian is included, so a
 * caller offering people to speak *as* filters them out itself.
 *
 * A failed read answers an empty listing rather than an error: the subscribers
 * are optional affordances on the composer, and a person list nobody could
 * fetch is a menu with nothing in it, not a chatbox that will not mount.
 *
 * One cache, so several subscribers do not each fire their own mount-time
 * fetch.
 */
export function usePeople() {
  return useQuery<PersonResource[]>({
    queryKey: PEOPLE_QUERY_KEY,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      fetchJson<PeopleList>("/api/people", { signal, fallback: "" })
        .then((listing) => listing.people)
        .catch(() => []),
  });
}
