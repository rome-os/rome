import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConciergeFollowChange,
  ConciergeFollowDto,
  ConciergeFollowingResponse,
  ConciergeFollowRules,
} from "@rome/api-types/concierge";
import { fetchJson } from "@/lib/fetch-json";

const CONCIERGE_FOLLOWING_QUERY_KEY = ["concierge-following"] as const;
const REFETCH_MS = 30_000;

/** One follow as a request names it. */
export interface FollowRef {
  source: string;
  target: string;
}

/**
 * What the Concierge follows: every source the guardian's connections offer,
 * the follows there, and the rules. The same structure the Concierge reads.
 * It changes from chat with no live event, so it is read again on focus and
 * every half minute while something shows it.
 */
export function useConciergeFollowing() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: CONCIERGE_FOLLOWING_QUERY_KEY,
    staleTime: 0,
    refetchInterval: REFETCH_MS,
    queryFn: ({ signal }) =>
      fetchJson<ConciergeFollowingResponse>("/api/concierge/following", { signal, fallback: "" }),
  });
  const update = (change: (prev: ConciergeFollowingResponse) => ConciergeFollowingResponse) =>
    queryClient.setQueryData<ConciergeFollowingResponse>(CONCIERGE_FOLLOWING_QUERY_KEY, (prev) =>
      prev ? change(prev) : prev,
    );
  const refresh = () => queryClient.invalidateQueries({ queryKey: CONCIERGE_FOLLOWING_QUERY_KEY });
  const replaceFollow = (source: string, follow: ConciergeFollowDto) =>
    update((prev) => ({
      ...prev,
      sources: prev.sources.map((entry) =>
        entry.source === source
          ? {
              ...entry,
              follows: entry.follows.map((f) => (f.target === follow.target ? follow : f)),
            }
          : entry,
      ),
    }));

  const configure = useMutation({
    mutationFn: async (change: ConciergeFollowChange & { target: string }) =>
      (
        await fetchJson<{ follow: ConciergeFollowDto }>("/api/concierge/following/item", {
          method: "PUT",
          json: change,
          fallback: "",
        })
      ).follow,
    onSuccess: (follow, change) => replaceFollow(change.source, follow),
    onError: () => void refresh(),
  });

  const unfollow = useMutation({
    mutationFn: async (ref: FollowRef) => {
      const query = new URLSearchParams({ source: ref.source, target: ref.target });
      await fetchJson<unknown>(`/api/concierge/following/item?${query}`, {
        method: "DELETE",
        fallback: "",
      });
      return ref;
    },
    onSuccess: (ref) =>
      update((prev) => ({
        ...prev,
        sources: prev.sources.map((entry) =>
          entry.source === ref.source
            ? { ...entry, follows: entry.follows.filter((f) => f.target !== ref.target) }
            : entry,
        ),
      })),
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

  const followCount = (query.data?.sources ?? []).reduce(
    (count, source) => count + (source.follows?.length ?? 0),
    0,
  );
  return {
    data: query.data,
    loaded: query.isFetched,
    followCount,
    configure,
    unfollow,
    setRules,
  };
}
