import { normalizeVisitorEmail } from "./visitor-email.js";

export interface DashboardAccessConfig {
  cloudEmailAccess: string[];
}

export const DASHBOARD_ACCESS_SETTING_KEY = "dashboardAccess";

/**
 * Set in `settings` once the members are the source of the invited emails,
 * by the members backfill's first run or by a save, whichever comes first.
 * Its value is the revision of the `dashboardAccess` setting that this build
 * last wrote, or last read the list from: read it with
 * {@link readInvitedEmailsDoneRevision}. A record with a higher revision was
 * saved by an older build after a rollback, and the next startup reads its
 * list again.
 */
export const INVITED_EMAILS_DONE_KEY = "backfill.membersFromInvitedEmails";

/** The revision stored under {@link INVITED_EMAILS_DONE_KEY}. 0 for any value
 *  that is not one, so a marker an earlier build of this one set to `true`
 *  has its list read once more. */
export function readInvitedEmailsDoneRevision(raw: unknown): number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
}

function normalizeEmailList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(raw.map(normalizeVisitorEmail).filter((email): email is string => email !== null)),
  ).sort();
}

export function normalizeDashboardAccessConfig(raw: unknown): DashboardAccessConfig {
  const body = (raw ?? {}) as { cloudEmailAccess?: unknown };
  return {
    cloudEmailAccess: normalizeEmailList(body.cloudEmailAccess),
  };
}

/**
 * The save counter stored in the `dashboardAccess` setting row. Every save of
 * the invited emails bumps it, and Rome Cloud drops a visitor list older than
 * the one it holds. The config API never exposes it.
 */
export function readDashboardAccessRevision(raw: unknown): number {
  const revision = (raw as { revision?: unknown } | null)?.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
    ? revision
    : 0;
}
