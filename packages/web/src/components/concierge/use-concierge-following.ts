import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConciergeAlertKind,
  ConciergeAlertRepoDto,
  ConciergeAlertRules,
  ConciergeAlertsResponse,
} from "@rome/api-types/concierge";
import { fetchJson } from "@/lib/fetch-json";

const CONCIERGE_FOLLOWING_QUERY_KEY = ["concierge-following"] as const;
const REFETCH_MS = 30_000;

const repoPath = (repo: string) =>
  `/api/concierge/alerts/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;

/**
 * The repos the Concierge follows and the rules that bound their alerts. The
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
      fetchJson<ConciergeAlertsResponse>("/api/concierge/alerts", { signal, fallback: "" }),
  });
  const update = (change: (prev: ConciergeAlertsResponse) => ConciergeAlertsResponse) =>
    queryClient.setQueryData<ConciergeAlertsResponse>(CONCIERGE_FOLLOWING_QUERY_KEY, (prev) =>
      prev ? change(prev) : prev,
    );
  const refresh = () => queryClient.invalidateQueries({ queryKey: CONCIERGE_FOLLOWING_QUERY_KEY });

  const setKind = useMutation({
    mutationFn: async (input: { repo: string; kind: ConciergeAlertKind; enabled: boolean }) =>
      (
        await fetchJson<{ repo: ConciergeAlertRepoDto }>(
          `${repoPath(input.repo)}/kinds/${input.kind}`,
          {
            method: "PUT",
            json: { enabled: input.enabled },
            fallback: "",
          },
        )
      ).repo,
    onSuccess: (repo) =>
      update((prev) => ({
        ...prev,
        repos: prev.repos.map((entry) => (entry.repo === repo.repo ? repo : entry)),
      })),
    onError: () => void refresh(),
  });

  const stopRepo = useMutation({
    mutationFn: async (repo: string) => {
      await fetchJson<unknown>(repoPath(repo), { method: "DELETE", fallback: "" });
      return repo;
    },
    onSuccess: (repo) =>
      update((prev) => ({ ...prev, repos: prev.repos.filter((entry) => entry.repo !== repo) })),
    onError: () => void refresh(),
  });

  const setRules = useMutation({
    mutationFn: async (change: Partial<ConciergeAlertRules>) =>
      (
        await fetchJson<{ rules: ConciergeAlertRules }>("/api/concierge/alerts/rules", {
          method: "PUT",
          json: change,
          fallback: "",
        })
      ).rules,
    onSuccess: (rules) => update((prev) => ({ ...prev, rules })),
    onError: () => void refresh(),
  });

  return { data: query.data, loaded: query.isFetched, setKind, stopRepo, setRules };
}
