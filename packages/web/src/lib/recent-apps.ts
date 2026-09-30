import type { AppOrigin } from "@rome/api-types/apps";

// The sidebar's Recent zone is derived, never stored: which apps and pages show
// is a pure function of the installed cards, Rome's own pages, the pin set, and
// a "last opened" map that lives in this browser (see hooks/use-recent-apps.ts).
// Everything here takes `now` as an argument so the expiry edge is testable.

/** Rows shown before "Show more". */
export const RECENT_APPS_VISIBLE = 3;
/** An app leaves the zone after this long without being installed or opened.
 *  14 days, not 7: a weekly habit would otherwise expire an hour before its
 *  next use. */
export const RECENT_APPS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** appId, or `pageVisitKey(pageId)` → ISO-8601 time of the last recorded open. */
export type AppLastOpened = Record<string, string>;

/** Where a visit to one of Rome's own pages sits in the last-opened map. App
 *  ids are lowercase letters, digits, and hyphens, or `@handle/slug`, so no app
 *  id contains a colon and the two kinds share one map without colliding. The
 *  shape matches the sidebar's pin keys. */
export function pageVisitKey(pageId: string): string {
  return `builtin:${pageId}`;
}

/** One of Rome's own pages, as the Recent zone weighs it. */
export interface RecentPageCandidate {
  id: string;
  displayName: string;
}

export type RecentEntry<A, P> = { kind: "app"; app: A } | { kind: "page"; page: P };

export interface RecentAppCandidate {
  id: string;
  displayName: string;
  hasFrontend: boolean;
  href: string | null;
  status: string;
  origin?: AppOrigin;
  installedAt?: string | null;
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function parseAppLastOpened(raw: unknown): AppLastOpened {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: AppLastOpened = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === "string" && toMs(value) !== null) out[id] = value;
  }
  return out;
}

/** Entries older than the window can no longer affect the zone. Dropping them
 *  on write keeps the map bounded without needing the installed list. */
export function pruneAppLastOpened(lastOpened: AppLastOpened, now: number): AppLastOpened {
  const out: AppLastOpened = {};
  for (const [id, iso] of Object.entries(lastOpened)) {
    const ms = toMs(iso);
    if (ms !== null && now - ms <= RECENT_APPS_WINDOW_MS) out[id] = iso;
  }
  return out;
}

// Built-in apps all install in one pass on a fresh instance's first boot. If
// that counted as activity, a new guardian's first sidebar would be a column
// of system apps. They earn a place only by being opened.
function installSignalMs(app: RecentAppCandidate): number | null {
  return app.origin === "builtin" ? null : toMs(app.installedAt);
}

export function lastActiveMs(app: RecentAppCandidate, lastOpened: AppLastOpened): number | null {
  const opened = toMs(lastOpened[app.id]);
  const installed = installSignalMs(app);
  if (opened === null) return installed;
  if (installed === null) return opened;
  return Math.max(opened, installed);
}

/** Installed (with a known time) and never opened. Legacy installs have no
 *  `installedAt`, so rollout day does not light a dot on every old app. */
export function isUnopened(app: RecentAppCandidate, lastOpened: AppLastOpened): boolean {
  return installSignalMs(app) !== null && toMs(lastOpened[app.id]) === null;
}

// Apps and pages rank on one clock, so a page visited after an app was opened
// sits above it. A page has no install signal: it earns a place only by being
// visited, the same rule built-in apps follow.
export function selectRecentEntries<A extends RecentAppCandidate, P extends RecentPageCandidate>(
  apps: readonly A[],
  pinnedAppIds: ReadonlySet<string>,
  pages: readonly P[],
  pinnedPageIds: ReadonlySet<string>,
  lastOpened: AppLastOpened,
  now: number,
): RecentEntry<A, P>[] {
  const rows: Array<{ entry: RecentEntry<A, P>; name: string; at: number }> = [];
  const inWindow = (at: number | null): at is number =>
    at !== null && now - at <= RECENT_APPS_WINDOW_MS;
  for (const app of apps) {
    if (!app.hasFrontend || !app.href) continue;
    if (app.status === "disabled") continue;
    if (pinnedAppIds.has(app.id)) continue;
    const at = lastActiveMs(app, lastOpened);
    if (!inWindow(at)) continue;
    rows.push({ entry: { kind: "app", app }, name: app.displayName, at });
  }
  for (const page of pages) {
    if (pinnedPageIds.has(page.id)) continue;
    const at = toMs(lastOpened[pageVisitKey(page.id)]);
    if (!inWindow(at)) continue;
    rows.push({ entry: { kind: "page", page }, name: page.displayName, at });
  }
  rows.sort((x, y) => y.at - x.at || x.name.localeCompare(y.name));
  return rows.map((row) => row.entry);
}
