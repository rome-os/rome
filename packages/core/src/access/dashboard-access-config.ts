import { normalizeVisitorEmail } from "./visitor-email.js";

export interface DashboardAccessConfig {
  cloudEmailAccess: string[];
}

export const DASHBOARD_ACCESS_SETTING_KEY = "dashboardAccess";

/**
 * Set in `settings` once the members are the source of the invited emails:
 * by the members backfill's first run, or by a save, whichever comes first.
 * From then on the list in the `dashboardAccess` setting is never read.
 */
export const INVITED_EMAILS_DONE_KEY = "backfill.membersFromInvitedEmails";

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
