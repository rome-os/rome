import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AppListResponse, InstalledAppCard, SpecSource } from "@rome/api-types/apps";
import { fetchJson } from "@/lib/fetch-json";

export interface UpgradeCandidate {
  appId: string;
  currentVersion: string;
  availableVersion: string;
  /** Source to send back via `POST /apps` to perform the upgrade. */
  targetSource: SpecSource;
}

export interface AppsResult {
  apps: InstalledAppCard[] | null;
  upgradable: Record<string, UpgradeCandidate>;
  error: Error | null;
}

// Two keys under one prefix: the authoritative installed list, and the
// advisory upgrade probe. They are invalidated independently (see
// useInvalidateApps) so lifecycle UX never blocks on the slow probe.
const LIST_QUERY_KEY = ["apps", "list"] as const;
const UPDATES_QUERY_KEY = ["apps", "updates"] as const;

export interface AppsListResult {
  apps: InstalledAppCard[] | null;
  error: Error | null;
}

// The authoritative installed list on its own — for surfaces that never read
// upgrade candidates (e.g. the app details page), so mounting them doesn't
// kick off the expensive per-app Rome Cloud updates probe. Shares
// LIST_QUERY_KEY with useApps, so the two stay one cache entry.
export function useAppsList(options?: { enabled?: boolean }): AppsListResult {
  const { t } = useTranslation("apps");
  // staleTime: 0 keeps this page eager — every mount/focus revalidates against
  // the server, so revisiting after a background app transition or an out-of-band
  // change shows current truth rather than a cached snapshot.
  const list = useQuery({
    queryKey: LIST_QUERY_KEY,
    enabled: options?.enabled,
    staleTime: 0,
    queryFn: ({ signal }) =>
      fetchJson<AppListResponse>("/api/apps", {
        signal,
        fallback: t("installed.errors.loadFailed"),
      }),
  });

  // Keep the last successful list on a background refetch error (the React Query
  // default) rather than blanking the page: a transient failure on a focus
  // refetch shouldn't wipe usable cards. Staleness is signaled by surfacing
  // `error` (consumers show a load-error banner above the still-rendered cards).
  return { apps: list.data?.apps ?? null, error: list.error };
}

// The advisory upgrade probe on its own. The probe is expensive (fans out to
// per-app Rome Cloud lookups), so it is not eager: fetched once on mount,
// refreshed explicitly after install/upgrade/uninstall via
// invalidateApps.updates(), and not re-run on every window focus.
// `probe: false` never fires the request at all — it only reads whatever a
// previous probe left in the cache. The app details page uses that mode so a
// deep link stays cheap (its contract: never fire the updates probe) while a
// visit from the apps grid still knows about the pending update.
export function useUpgradeCandidates(options?: {
  probe?: boolean;
}): Record<string, UpgradeCandidate> {
  const { t } = useTranslation("apps");
  const updates = useQuery({
    queryKey: UPDATES_QUERY_KEY,
    enabled: options?.probe !== false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      fetchJson<{ upgradable?: UpgradeCandidate[] }>("/api/apps/updates", {
        signal,
        fallback: t("installed.errors.loadFailed"),
      }),
  });

  // `useQuery` retains the last successful `data` when a later refetch errors.
  // For the advisory probe that means a stale upgrade badge would stick after a
  // failed refetch, so drop it on error to honor the "degrade to none" contract.
  const upgradable: Record<string, UpgradeCandidate> = {};
  if (!updates.isError) {
    for (const candidate of updates.data?.upgradable ?? []) {
      upgradable[candidate.appId] = candidate;
    }
  }
  return upgradable;
}

// The installed list and the upgrade probe are independent: the
// list is authoritative, while `/api/apps/updates` can do slow Rome Cloud/network
// lookups. Running them as separate queries lets the cards settle (and lifecycle
// mutations leave their "acting" state) the moment the list returns, regardless
// of whether update detection is slow or failing.
export function useApps(): AppsResult {
  const { apps, error } = useAppsList();
  const upgradable = useUpgradeCandidates();

  return {
    apps,
    upgradable,
    // Only the authoritative list surfaces a load error; the updates probe is
    // advisory and degrades to "no updates" on failure.
    error,
  };
}

export interface AppInvalidators {
  // The authoritative list. Await this for lifecycle "acting" UX — it settles
  // as soon as the list is back, independent of the upgrade probe.
  list: () => Promise<void>;
  // The advisory upgrade probe. Fire (don't await) only after a mutation that
  // can change upgrade availability (install / upgrade); skip it for ones that
  // can't (enable-disable, public-access, uninstall).
  updates: () => Promise<void>;
}

// Hand back to any mutation so a successful write pulls fresh server truth
// instead of hand-patching local card state. Split so a write never blocks the
// UI on, or needlessly reruns, the slow upgrade probe.
export function useInvalidateApps(): AppInvalidators {
  const queryClient = useQueryClient();
  return {
    list: () => queryClient.invalidateQueries({ queryKey: LIST_QUERY_KEY }),
    // reset (not invalidate) so the prior candidates are dropped immediately
    // rather than lingering while the probe refetches — otherwise a just-upgraded
    // app keeps its green "update available" badge and invites a redundant
    // second upgrade until the fresh probe returns.
    updates: () => queryClient.resetQueries({ queryKey: UPDATES_QUERY_KEY }),
  };
}
