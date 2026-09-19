import { useQuery } from "@tanstack/react-query";
import type { DashboardIdentity } from "@rome/api-types";
import { fetchJson } from "@/lib/fetch-json";

export const DASHBOARD_IDENTITY_QUERY_KEY = ["dashboard-identity"] as const;

// Who the current dashboard session belongs to (guardian or dashboard
// visitor), for display surfaces like the sidebar profile menu. Identity only
// changes across login/logout/account creation. Client-side auth mutations
// explicitly invalidate this otherwise page-lifetime query.
export function useDashboardIdentity() {
  return useQuery<DashboardIdentity>({
    queryKey: DASHBOARD_IDENTITY_QUERY_KEY,
    queryFn: () =>
      fetchJson<DashboardIdentity>("/api/auth/me", { fallback: "Failed to load identity" }),
    staleTime: Infinity,
  });
}
