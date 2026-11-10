import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/fetch-json";
import { UPGRADE_CHECK_PATH, type UpgradeCheck } from "./use-system-upgrade";

export const UPGRADE_CHECK_INTERVAL_MS = 15 * 60_000;
/** Without requestIdleCallback (Safari), start the first check this long after mount. */
const IDLE_FALLBACK_MS = 2_000;

const RELEASE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Whether release version `latest` is newer than `current`. False when either
 * is not a plain `major.minor.patch`: a version we can't order must not offer
 * an upgrade, and neither must an older or equal one (a test image or a
 * rollback runs ahead of the published latest).
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = RELEASE_VERSION.exec(latest);
  const b = RELEASE_VERSION.exec(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * The release a check offers, or null: Rome Cloud must flag an upgrade *and*
 * its latest must be strictly newer. The one rule every web surface uses.
 */
export function offeredVersion(check: UpgradeCheck): string | null {
  const current = check.current.version;
  return check.upgradeAvailable && current !== null && isNewerVersion(check.latest.version, current)
    ? check.latest.version
    : null;
}

/** True once the browser is idle after mount and the tab is visible. */
function useIdleAndVisible(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    const markReady = () => {
      if (disposed) return;
      if (document.visibilityState === "hidden") {
        document.addEventListener("visibilitychange", markReady, { once: true });
        return;
      }
      setReady(true);
    };
    let cancel: () => void;
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(markReady);
      cancel = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(markReady, IDLE_FALLBACK_MS);
      cancel = () => window.clearTimeout(id);
    }
    return () => {
      disposed = true;
      cancel();
      document.removeEventListener("visibilitychange", markReady);
    };
  }, []);
  return ready;
}

export interface UpgradeAvailability {
  /** The newer release to offer, or null when there is none or the check failed. */
  latest: string | null;
  recheck: () => unknown;
  rechecking: boolean;
}

/**
 * Background upgrade check for the sidebar indicator: once when the page goes
 * idle after load, then every 15 minutes while the tab is visible (React
 * Query pauses the interval in a hidden tab and catches up on return). Any
 * failure — not managed by Rome Cloud, a dev build, Rome Cloud unreachable —
 * reads as "nothing to offer".
 */
export function useUpgradeAvailable(enabled: boolean): UpgradeAvailability {
  const ready = useIdleAndVisible();
  const query = useQuery({
    queryKey: ["upgrade-available"] as const,
    enabled: enabled && ready,
    retry: false,
    staleTime: UPGRADE_CHECK_INTERVAL_MS,
    refetchInterval: UPGRADE_CHECK_INTERVAL_MS,
    queryFn: ({ signal }) => fetchJson<UpgradeCheck>(UPGRADE_CHECK_PATH, { signal, fallback: "" }),
  });
  // React Query keeps the last good data when a refetch fails; a failed check
  // must not leave a stale offer up.
  const check = query.error ? null : query.data;
  const latest = check ? offeredVersion(check) : null;
  return { latest, recheck: () => query.refetch(), rechecking: query.isFetching };
}
