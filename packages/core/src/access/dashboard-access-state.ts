import type { DrizzleDb } from "../db/index.js";
import { guardianEmails, memberContext, memberEmails } from "./application/members.js";
import { normalizeVisitorEmail } from "./visitor-email.js";

/**
 * In-memory copy of the members' Rome Cloud sign-in emails and the
 * guardian's, for the auth-edge probe.
 *
 * Caddy `forward_auth` calls `/api/auth/verify` on every proxied request,
 * so the probe can't afford a DB round-trip. This state is loaded from the
 * members at startup and reloaded after each save of the invited emails and
 * each change of the guardian's seat. The members' emails say whether anyone
 * besides the guardian may open the dashboard. A sign-in with either set's
 * email is let in, since a sign-in with the guardian's email is the
 * guardian's person.
 */
export class DashboardAccessState {
  private memberEmails: Set<string> = new Set();
  private guardianEmails: Set<string> = new Set();

  /** The members' emails, the guardian's left out. */
  cloudEmails(): ReadonlySet<string> {
    return new Set(this.memberEmails);
  }

  /** Whether at least one member is invited. */
  hasCloudEmailAccess(): boolean {
    return this.memberEmails.size > 0;
  }

  /** Whether a Rome Cloud sign-in with `email` is a member's or the guardian's. */
  isCloudEmailAllowed(email: string): boolean {
    const normalized = normalizeVisitorEmail(email);
    return (
      normalized !== null &&
      (this.memberEmails.has(normalized) || this.guardianEmails.has(normalized))
    );
  }

  /** Replaces the members' emails, keeping the guardian's. */
  setCloudEmailAccess(emails: Iterable<string>): void {
    this.memberEmails = normalizedSet(emails);
  }

  /** Replaces both sets with the sign-in emails of the members and the guardian in `db`. */
  async load(db: DrizzleDb): Promise<void> {
    const ctx = memberContext(db);
    const members = await memberEmails(ctx);
    const guardian = await guardianEmails(ctx);
    this.memberEmails = normalizedSet(members);
    this.guardianEmails = normalizedSet(guardian);
  }
}

function normalizedSet(emails: Iterable<string>): Set<string> {
  return new Set(
    Array.from(emails, normalizeVisitorEmail).filter((email): email is string => email !== null),
  );
}
