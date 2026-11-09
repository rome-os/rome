import { normalizePublicAccessEmail } from "../apps/public-access-config.js";

export interface DashboardAccessConfig {
  cloudEmailAccess: string[];
}

export const DASHBOARD_ACCESS_SETTING_KEY = "dashboardAccess";

export const DEFAULT_DASHBOARD_ACCESS_CONFIG: DashboardAccessConfig = {
  cloudEmailAccess: [],
};

function normalizeEmailList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(raw.map(normalizePublicAccessEmail).filter((email): email is string => email !== null)),
  ).sort();
}

export function normalizeDashboardAccessConfig(raw: unknown): DashboardAccessConfig {
  const body = (raw ?? {}) as { cloudEmailAccess?: unknown };
  return {
    cloudEmailAccess: normalizeEmailList(body.cloudEmailAccess),
  };
}

/**
 * The save counter stored beside the allow-list in the same setting row. Every
 * save bumps it, and Rome Cloud drops a visitor list older than the one it holds.
 * The config API never exposes it.
 */
export function readDashboardAccessRevision(raw: unknown): number {
  const revision = (raw as { revision?: unknown } | null)?.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
    ? revision
    : 0;
}
