import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Approval } from "@/pages/ActivityPage";
import { fetchJson } from "@/lib/fetch-json";

export const APPROVALS_QUERY_KEY = ["approvals"] as const;

export function useApprovals() {
  const { t } = useTranslation("activity");
  return useQuery({
    queryKey: APPROVALS_QUERY_KEY,
    queryFn: async () => {
      const rows = await fetchJson<Approval[]>("/api/approvals", {
        fallback: t("pairing.loadFailed"),
      });
      if (!Array.isArray(rows)) throw new Error(t("pairing.loadFailed"));
      return rows;
    },
    refetchInterval: 5_000,
  });
}

export function useResolveApproval() {
  const client = useQueryClient();
  const { t } = useTranslation("activity");
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject" }) =>
      fetchJson(`/api/approvals/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        json: { action },
        fallback: t("pairing.resolveFailed"),
      }),
    onSettled: () => client.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY }),
  });
}
