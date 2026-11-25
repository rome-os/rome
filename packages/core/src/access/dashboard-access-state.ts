import type { DrizzleDb } from "../db/index.js";
import { memberContext, memberEmails } from "./application/members.js";
import type { DashboardAccessConfig } from "./dashboard-access-config.js";
import { normalizeVisitorEmail } from "./visitor-email.js";

/**
 * In-memory copy of the members' emails for the auth-edge probe.
 *
 * Caddy `forward_auth` calls `/api/auth/verify` on every proxied request,
 * so the probe can't afford a DB round-trip. This state is loaded from the
 * members once at startup and refreshed by `/api/dashboard-access`. It holds
 * no guardian's email: the guardian's seat says who the guardian is.
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
    const normalized = normalizeVisitorEmail(email);
    return normalized !== null && this.cloudEmailAccess.has(normalized);
  }

  setCloudEmailAccess(emails: Iterable<string>): void {
    const normalized = Array.from(emails, normalizeVisitorEmail).filter(
      (email): email is string => email !== null,
    );
    this.cloudEmailAccess = new Set(normalized);
  }

  setConfig(config: DashboardAccessConfig): void {
    this.setCloudEmailAccess(config.cloudEmailAccess);
  }

  /** Replaces the emails with those of every member in `db`. */
  async load(db: DrizzleDb): Promise<void> {
    this.setCloudEmailAccess(await memberEmails(memberContext(db)));
  }
}
