import { useQuery } from "@tanstack/react-query";
import type { DashboardIdentity } from "@rome/api-types";
import { fetchJson } from "@/lib/fetch-json";

export const DASHBOARD_IDENTITY_QUERY_KEY = ["dashboard-identity"] as const;

// Who the current dashboard session belongs to (guardian or dashboard
// visitor), for display surfaces like the sidebar profile menu. Identity only
// changes across login/logout, and both end in a full navigation that resets
// the query cache, so the cached value never goes stale within a page life.
export function useDashboardIdentity({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<DashboardIdentity>({
    queryKey: DASHBOARD_IDENTITY_QUERY_KEY,
    queryFn: () =>
      fetchJson<DashboardIdentity>("/api/auth/me", { fallback: "Failed to load identity" }),
    staleTime: Infinity,
    enabled,
  });
}
