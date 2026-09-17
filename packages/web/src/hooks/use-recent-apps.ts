import { useEffect, useMemo, useRef, useState } from "react";
import { saveSetting } from "@/lib/chat-api";
import { useInvalidateSettings, useSettings } from "@/hooks/use-settings";
import {
  type AppLastOpened,
  type RecentAppCandidate,
  isUnopened,
  mergeAppLastOpened,
  parseAppLastOpened,
  pruneAppLastOpened,
  selectRecentApps,
  shouldRecordOpen,
} from "@/lib/recent-apps";

const APP_LAST_OPENED_KEY = "appLastOpened";
export const APP_LAST_OPENED_STORAGE_KEY = "rome-app-last-opened";
// Same-document poke, the counterpart of `rome-pins-changed`. An open recorded
// inside a split-view iframe reaches the sidebar through the `storage` event
// instead, which fires in every other same-origin document.
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

// localStorage answers first render, the settings query then reconciles. Unlike
// the pin set, the server is not simply authoritative here: an open recorded on
// this device moments ago may not have reached it yet, so the two are merged.
export function useAppLastOpened(): AppLastOpened {
  const [value, setValue] = useState<AppLastOpened>(readLocal);
  const { data: settings } = useSettings();

  useEffect(() => {
    if (!settings) return;
    const merged = mergeAppLastOpened(
      readLocal(),
      parseAppLastOpened(settings[APP_LAST_OPENED_KEY]),
    );
    writeLocal(merged);
    setValue(merged);
  }, [settings]);

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
  /** The subset of `recent` that was installed but never opened. */
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

// Records that the guardian opened `appId`. `enabled` must be false for anyone
// else: the same host pages serve public visitors, who have no settings to read
// or write. Waits for settings to load so it merges against server truth and
// never persists a truncated map (the rule the old seen-apps ledger followed).
export function useRecordAppOpened(appId: string | undefined, enabled: boolean): void {
  const { data: settings } = useSettings({ enabled });
  const invalidateSettings = useInvalidateSettings();
  const recordedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !appId || settings === undefined) return;
    if (recordedFor.current === appId) return;
    recordedFor.current = appId;

    const now = Date.now();
    const merged = mergeAppLastOpened(
      readLocal(),
      parseAppLastOpened(settings[APP_LAST_OPENED_KEY]),
    );
    if (!shouldRecordOpen(appId, merged, now)) return;

    const next = pruneAppLastOpened({ ...merged, [appId]: new Date(now).toISOString() }, now);
    writeLocal(next);
    window.dispatchEvent(new Event(APP_OPENED_EVENT));
    void saveSetting(APP_LAST_OPENED_KEY, next).then(() => invalidateSettings());
  }, [appId, enabled, settings, invalidateSettings]);
}
