import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/fetch-json";

const SETTINGS_QUERY_KEY = ["settings"] as const;

export type SettingsMap = Record<string, unknown>;

// Single source of truth for /api/settings. Multiple mount-time subscribers
// (AppGrid, ChatComponent, ChatComposer, AppsIndexPage) share one in-flight
// request and one cache, instead of each component fetching independently.
// `enabled: false` keeps a caller that may not be a guardian (an embedded app
// page serving a public visitor) from issuing a request the backend rejects.
export function useSettings(options: { enabled?: boolean } = {}) {
  return useQuery<SettingsMap>({
    queryKey: SETTINGS_QUERY_KEY,
    staleTime: 60_000,
    enabled: options.enabled ?? true,
    queryFn: ({ signal }) => fetchJson<SettingsMap>("/api/settings", { signal, fallback: "" }),
  });
}

export function useInvalidateSettings() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
}
