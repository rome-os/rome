import { toast } from "sonner";
import { pairingPayload, PAIRING_HISTORY_PAGE_SIZE } from "@rome/api-types/approvals";
import { useMutation, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Approval } from "@/pages/ActivityPage";
import { fetchJson } from "@/lib/fetch-json";

export const APPROVALS_QUERY_KEY = ["approvals"] as const;

export function useApprovals() {
  const { t } = useTranslation("activity");
  return useInfiniteQuery({
    queryKey: APPROVALS_QUERY_KEY,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const rows = await fetchJson<Approval[]>(
        pageParam ? `/api/approvals?pairingHistoryOffset=${pageParam}` : "/api/approvals",
        {
          fallback: t("pairing.loadFailed"),
        },
      );
      if (!Array.isArray(rows)) throw new Error(t("pairing.loadFailed"));
      return rows;
    },
    getNextPageParam: (lastPage, _pages, lastOffset) =>
      lastPage.filter((row) => pairingPayload(row) && row.status !== "pending").length ===
      PAIRING_HISTORY_PAGE_SIZE
        ? lastOffset + PAIRING_HISTORY_PAGE_SIZE
        : undefined,
    select: (data) => [...new Map(data.pages.flat().map((row) => [row.id, row])).values()],
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
    onError: (error) => toast.error(error.message),
    onSettled: () => client.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY }),
  });
}
