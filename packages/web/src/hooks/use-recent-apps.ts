import { useEffect, useMemo, useState } from "react";
import {
  type AppLastOpened,
  type RecentAppCandidate,
  isUnopened,
  parseAppLastOpened,
  pruneAppLastOpened,
  selectRecentApps,
} from "@/lib/recent-apps";

// "Last opened" lives in this browser only, on purpose. It is cache-shaped
// data: it regrows as the guardian uses apps, and a phone and a laptop have
// different habits, so each device keeps its own list. Only the pin set is a
// deliberate setting worth syncing. The install time, the other half of the
// Recent zone, comes from the server with each app card.
export const APP_LAST_OPENED_STORAGE_KEY = "rome-app-last-opened";
// Same-document poke, the counterpart of `rome-pins-changed`. An open recorded
// in another tab reaches this sidebar through the `storage` event instead,
// which fires in every other same-origin document.
const APP_OPENED_EVENT = "rome-app-opened";

function readLocal(): AppLastOpened {
  try {
    const stored = localStorage.getItem(APP_LAST_OPENED_STORAGE_KEY);
    return stored ? parseAppLastOpened(JSON.parse(stored)) : {};
  } catch {
    return {};
  }
}

function writeLocal(value: AppLastOpened): void {
  try {
    localStorage.setItem(APP_LAST_OPENED_STORAGE_KEY, JSON.stringify(value));
  } catch {}
}

export function useAppLastOpened(): AppLastOpened {
  const [value, setValue] = useState<AppLastOpened>(readLocal);

  useEffect(() => {
    const sync = () => setValue(readLocal());
    const onStorage = (event: StorageEvent) => {
      if (event.key === APP_LAST_OPENED_STORAGE_KEY) sync();
    };
    window.addEventListener(APP_OPENED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(APP_OPENED_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return value;
}

interface RecentApps<T> {
  /** Unpinned apps active within the window, most recent first. */
  recent: T[];
  /** The subset of `recent` that was installed but never opened here. */
  unopenedIds: ReadonlySet<string>;
}

export function useRecentApps<T extends RecentAppCandidate>(
  apps: readonly T[],
  pinnedAppIds: ReadonlySet<string>,
): RecentApps<T> {
  const lastOpened = useAppLastOpened();
  return useMemo(() => {
    const recent = selectRecentApps(apps, pinnedAppIds, lastOpened, Date.now());
    const unopenedIds = new Set(
      recent.filter((app) => isUnopened(app, lastOpened)).map((app) => app.id),
    );
    return { recent, unopenedIds };
  }, [apps, pinnedAppIds, lastOpened]);
}

// Records that the guardian opened `appId` on this device. `enabled` is false
// while the app has not loaded for a guardian (a public visitor, or a manifest
// still on its way), so a failed or foreign open never counts.
export function useRecordAppOpened(appId: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !appId) return;
    const now = Date.now();
    const next = pruneAppLastOpened({ ...readLocal(), [appId]: new Date(now).toISOString() }, now);
    writeLocal(next);
    window.dispatchEvent(new Event(APP_OPENED_EVENT));
  }, [appId, enabled]);
}
