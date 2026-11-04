import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConciergeAlertKind,
  ConciergeAlertRepoDto,
  ConciergeAlertRules,
  ConciergeAlertsResponse,
} from "@rome/api-types/concierge";
import { fetchJson } from "@/lib/fetch-json";

const CONCIERGE_ALERTS_QUERY_KEY = ["concierge-alerts"] as const;

const repoPath = (repo: string) =>
  `/api/concierge/alerts/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;

/**
 * The repos the Concierge watches and the rules that bound its alerts. Read
 * again whenever the tab opens, since the Concierge changes them from chat.
 */
export function useConciergeAlerts() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: CONCIERGE_ALERTS_QUERY_KEY,
    staleTime: 0,
    queryFn: ({ signal }) =>
      fetchJson<ConciergeAlertsResponse>("/api/concierge/alerts", { signal, fallback: "" }),
  });
  const update = (change: (prev: ConciergeAlertsResponse) => ConciergeAlertsResponse) =>
    queryClient.setQueryData<ConciergeAlertsResponse>(CONCIERGE_ALERTS_QUERY_KEY, (prev) =>
      prev ? change(prev) : prev,
    );
  const refresh = () => queryClient.invalidateQueries({ queryKey: CONCIERGE_ALERTS_QUERY_KEY });

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
