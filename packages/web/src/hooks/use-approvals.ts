import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Approval } from "@/pages/ActivityPage";
import { fetchJson } from "@/lib/fetch-json";
import { emitSessionsChanged } from "@/lib/session-events";

const APPROVALS_QUERY_KEY = ["approvals"] as const;

export function useApprovals({ status }: { status?: "pending" } = {}) {
  const { t } = useTranslation("activity");
  return useQuery({
    queryKey: status ? [...APPROVALS_QUERY_KEY, status] : APPROVALS_QUERY_KEY,
    queryFn: async () => {
      const rows = await fetchJson<Approval[]>(
        status ? `/api/approvals?status=${status}` : "/api/approvals",
        {
          fallback: t("approvals.loadFailed"),
        },
      );
      if (!Array.isArray(rows)) throw new Error(t("approvals.loadFailed"));
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
        fallback: t("approvals.resolveFailed"),
      }),
    onError: (error) => toast.error(error.message),
    // A resolved approval can clear a chat's "waiting" mark in the sidebar.
    onSuccess: () => emitSessionsChanged(),
    onSettled: () => client.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY }),
  });
}
