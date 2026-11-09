import { eq } from "drizzle-orm";
import { settings } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  DEFAULT_DASHBOARD_ACCESS_CONFIG,
  normalizeDashboardAccessConfig,
  type DashboardAccessConfig,
} from "./dashboard-access-config.js";
import { normalizePublicAccessEmail } from "./public-access-config.js";

/**
 * In-memory cache of dashboard visitor policy for the auth-edge probe.
 *
 * Caddy `forward_auth` calls `/api/auth/verify` on every proxied request,
 * so the probe can't afford a DB round-trip to read settings. This state
 * is loaded once at startup and refreshed by `/api/dashboard-access`.
 */
export class DashboardAccessState {
  private cloudEmailAccess: Set<string> = new Set();

  cloudEmails(): ReadonlySet<string> {
    return new Set(this.cloudEmailAccess);
  }

  hasCloudEmailAccess(): boolean {
    return this.cloudEmailAccess.size > 0;
  }

  isCloudEmailAllowed(email: string): boolean {
    const normalized = normalizePublicAccessEmail(email);
    return normalized !== null && this.cloudEmailAccess.has(normalized);
  }

  setCloudEmailAccess(emails: Iterable<string>): void {
    const normalized = Array.from(emails, normalizePublicAccessEmail).filter(
      (email): email is string => email !== null,
    );
    this.cloudEmailAccess = new Set(normalized);
  }

  setConfig(config: DashboardAccessConfig): void {
    this.setCloudEmailAccess(config.cloudEmailAccess);
  }

  async load(db: DrizzleDb): Promise<void> {
    const rows = await db
      .select()
      .from(settings)
      .where(eq(settings.key, DASHBOARD_ACCESS_SETTING_KEY));
    const config =
      rows.length > 0 && rows[0].value
        ? normalizeDashboardAccessConfig(rows[0].value)
        : DEFAULT_DASHBOARD_ACCESS_CONFIG;
    this.setConfig(config);
  }
}
