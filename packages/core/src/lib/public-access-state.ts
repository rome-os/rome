import { eq } from "drizzle-orm";
import { settings } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import {
  DEFAULT_PUBLIC_ACCESS_CONFIG,
  normalizePublicAccessConfig,
  type PublicAccessConfig,
} from "./public-access-config.js";

/**
 * In-memory cache of public app access policy for the auth-edge probe.
 *
 * Caddy `forward_auth` calls `/api/auth/verify` on every proxied request,
 * so the probe can't afford a DB round-trip to read settings. This state
 * is loaded once at startup and refreshed by the `/api/public-access`
 * PUT handler after each write.
 */
export class PublicAccessState {
  private allowed: Set<string> = new Set();
  private cloudEmailAccess: Map<string, Set<string>> = new Map();

  allowedApps(): ReadonlySet<string> {
    return new Set(this.allowed);
  }

  cloudEmailApps(): ReadonlySet<string> {
    return new Set(this.cloudEmailAccess.keys());
  }

  cloudEmailsForApp(appId: string): ReadonlySet<string> {
    return new Set(this.cloudEmailAccess.get(appId) ?? []);
  }

  isCloudEmailApp(appId: string): boolean {
    return this.cloudEmailAccess.has(appId);
  }

  /** True when the app is link-public (listed in `allowedApps`). */
  isPublicApp(appId: string): boolean {
    return this.allowed.has(appId);
  }

  setAllowedApps(allowedApps: Iterable<string>): void {
    this.allowed = new Set(allowedApps);
  }

  setCloudEmailAccess(cloudEmailAccess: Record<string, string[]>): void {
    this.cloudEmailAccess = new Map(
      Object.entries(cloudEmailAccess).map(([appId, emails]) => [appId, new Set(emails)]),
    );
  }

  setConfig(config: { allowedApps: Iterable<string>; cloudEmailAccess: Record<string, string[]> }) {
    this.setAllowedApps(config.allowedApps);
    this.setCloudEmailAccess(config.cloudEmailAccess);
  }

  /** Loads and normalizes the stored policy, updates this snapshot, and returns that config. */
  async load(db: DrizzleDb): Promise<PublicAccessConfig> {
    const rows = await db.select().from(settings).where(eq(settings.key, "publicAccess"));
    const config =
      rows.length > 0 && rows[0].value
        ? normalizePublicAccessConfig(rows[0].value)
        : DEFAULT_PUBLIC_ACCESS_CONFIG;
    this.setConfig(config);
    return config;
  }
}
