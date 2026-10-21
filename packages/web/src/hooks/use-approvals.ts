import { toast } from "sonner";
import { pairingPayload, PAIRING_HISTORY_PAGE_SIZE } from "@rome/api-types/approvals";
import { useMutation, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Approval } from "@/pages/ActivityPage";
import { fetchJson } from "@/lib/fetch-json";
import { emitSessionsChanged } from "@/lib/session-events";

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

/** A pairing request the guardian can still decide: pending, and not past the
 *  expiry the server stamped on it. The server expires it on its next read, so
 *  between polls the clock is what hides a request nobody can approve any more. */
export function isPendingPairing(approval: Approval): boolean {
  const payload = pairingPayload(approval);
  return !!payload && approval.status === "pending" && payload.expiresAt > Date.now();
}

/**
 * The pairing requests waiting on the guardian. The sidebar keeps this read
 * mounted on every page, so it asks for the first page only: the history pages
 * Activity loads stay with Activity's query instead of being re-polled from
 * wherever the guardian goes next. Its key sits under the approvals key, so a
 * resolve refreshes it along with everything else.
 */
export function usePendingPairings() {
  const { t } = useTranslation("activity");
  const query = useQuery({
    queryKey: [...APPROVALS_QUERY_KEY, "pending-pairings"],
    queryFn: async () => {
      const rows = await fetchJson<Approval[]>("/api/approvals", {
        fallback: t("pairing.loadFailed"),
      });
      if (!Array.isArray(rows)) throw new Error(t("pairing.loadFailed"));
      return rows;
    },
    refetchInterval: 5_000,
  });
  return { query, rows: query.data?.filter(isPendingPairing) ?? [] };
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
    // A resolved approval can clear a chat's "waiting" mark in the sidebar.
    onSuccess: () => emitSessionsChanged(),
    onSettled: () => client.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY }),
  });
}
