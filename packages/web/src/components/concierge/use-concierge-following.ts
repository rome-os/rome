import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConciergeFollowedItemDto,
  ConciergeFollowingResponse,
  ConciergeFollowRules,
  ConciergeFollowSource,
} from "@rome/api-types/concierge";
import { fetchJson } from "@/lib/fetch-json";

const CONCIERGE_FOLLOWING_QUERY_KEY = ["concierge-following"] as const;
const REFETCH_MS = 30_000;

/** One followed item as a request names it. */
export interface FollowedRef {
  source: ConciergeFollowSource;
  target: string;
}

const itemPath = ({ source, target }: FollowedRef, rest = "") =>
  `/api/concierge/following/${source}${rest}?target=${encodeURIComponent(target)}`;

const sameItem = (a: FollowedRef, b: FollowedRef) => a.source === b.source && a.target === b.target;

/**
 * What the Concierge follows and the rules that bound its events. The
 * Concierge changes them from chat with no live event, so the list is read
 * again on focus and every half minute while something shows it.
 */
export function useConciergeFollowing() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: CONCIERGE_FOLLOWING_QUERY_KEY,
    staleTime: 0,
    refetchInterval: REFETCH_MS,
    queryFn: ({ signal }) =>
      fetchJson<ConciergeFollowingResponse>("/api/concierge/following", {
        signal,
        fallback: "",
      }),
  });
  const update = (change: (prev: ConciergeFollowingResponse) => ConciergeFollowingResponse) =>
    queryClient.setQueryData<ConciergeFollowingResponse>(CONCIERGE_FOLLOWING_QUERY_KEY, (prev) =>
      prev ? change(prev) : prev,
    );
  const refresh = () => queryClient.invalidateQueries({ queryKey: CONCIERGE_FOLLOWING_QUERY_KEY });

  const setKind = useMutation({
    mutationFn: async (input: FollowedRef & { kind: string; enabled: boolean }) =>
      (
        await fetchJson<{ item: ConciergeFollowedItemDto }>(
          itemPath(input, `/kinds/${encodeURIComponent(input.kind)}`),
          { method: "PUT", json: { enabled: input.enabled }, fallback: "" },
        )
      ).item,
    onSuccess: (item) =>
      update((prev) => ({
        ...prev,
        items: prev.items.map((entry) => (sameItem(entry, item) ? item : entry)),
      })),
    onError: () => void refresh(),
  });

  const unfollow = useMutation({
    mutationFn: async (ref: FollowedRef) => {
      await fetchJson<unknown>(itemPath(ref), { method: "DELETE", fallback: "" });
      return ref;
    },
    onSuccess: (ref) =>
      update((prev) => ({ ...prev, items: prev.items.filter((entry) => !sameItem(entry, ref)) })),
    onError: () => void refresh(),
  });

  const setRules = useMutation({
    mutationFn: async (change: Partial<ConciergeFollowRules>) =>
      (
        await fetchJson<{ rules: ConciergeFollowRules }>("/api/concierge/following/rules", {
          method: "PUT",
          json: change,
          fallback: "",
        })
      ).rules,
    onSuccess: (rules) => update((prev) => ({ ...prev, rules })),
    onError: () => void refresh(),
  });

  return { data: query.data, loaded: query.isFetched, setKind, unfollow, setRules };
}
