import { useEffect, useMemo, useState } from "react";
import {
  type AppLastOpened,
  type RecentAppCandidate,
  type RecentEntry,
  type RecentPageCandidate,
  isUnopened,
  pageVisitKey,
  parseAppLastOpened,
  pruneAppLastOpened,
  selectRecentEntries,
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

interface RecentApps<A, P> {
  /** Unpinned apps and pages active within the window, most recent first. */
  recent: RecentEntry<A, P>[];
  /** Ids of the recent apps that were installed but never opened here. */
  unopenedIds: ReadonlySet<string>;
}

export function useRecentApps<A extends RecentAppCandidate, P extends RecentPageCandidate>(
  apps: readonly A[],
  pinnedAppIds: ReadonlySet<string>,
  pages: readonly P[],
  pinnedPageIds: ReadonlySet<string>,
): RecentApps<A, P> {
  const lastOpened = useAppLastOpened();
  return useMemo(() => {
    const recent = selectRecentEntries(
      apps,
      pinnedAppIds,
      pages,
      pinnedPageIds,
      lastOpened,
      Date.now(),
    );
    const unopenedIds = new Set(
      recent.flatMap((entry) =>
        entry.kind === "app" && isUnopened(entry.app, lastOpened) ? [entry.app.id] : [],
      ),
    );
    return { recent, unopenedIds };
  }, [apps, pinnedAppIds, pages, pinnedPageIds, lastOpened]);
}

function recordOpened(key: string): void {
  const now = Date.now();
  writeLocal(pruneAppLastOpened({ ...readLocal(), [key]: new Date(now).toISOString() }, now));
  window.dispatchEvent(new Event(APP_OPENED_EVENT));
}

// Records that the guardian opened `appId` on this device. `enabled` is false
// while the app has not loaded for a guardian (a public visitor, or a manifest
// still on its way), so a failed or foreign open never counts.
export function useRecordAppOpened(appId: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (enabled && appId) recordOpened(appId);
  }, [appId, enabled]);
}

// Records a visit to one of Rome's own pages, once per arrival: moving between
// a page's own sub-routes keeps the same `pageId` and records nothing new.
export function useRecordPageVisited(pageId: string | null): void {
  useEffect(() => {
    if (pageId) recordOpened(pageVisitKey(pageId));
  }, [pageId]);
}
