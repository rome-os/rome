import type { DrizzleDb } from "../db/index.js";
import { memberContext, memberEmails } from "./application/members.js";
import { guardianSeatEmail } from "./guardian-auth-state.js";
import { normalizeVisitorEmail } from "./visitor-email.js";

/**
 * In-memory copy of the members' Rome Cloud sign-in emails and the
 * guardian's seat's email, for the auth-edge probe.
 *
 * Caddy `forward_auth` calls `/api/auth/verify` on every proxied request,
 * so the probe can't afford a DB round-trip. This state is loaded from the
 * members and the seat at startup and reloaded after each save of the invited
 * emails and each change of the guardian's seat. The members' emails say
 * whether anyone besides the guardian may open the dashboard, which keeps the
 * guardian's chats private. The sign-in and session gates also open for the
 * seat's email alone. A sign-in with a member's email or the seat's email is
 * let in, since a sign-in with the seat's email is the guardian's person.
 * Another email the guardian's person holds is not let in.
 */
export class DashboardAccessState {
  private memberEmails: Set<string> = new Set();
  private guardianEmail: string | null = null;

  /** The members' emails, the guardian's left out. */
  cloudEmails(): ReadonlySet<string> {
    return new Set(this.memberEmails);
  }

  /** Whether at least one member is invited. */
  hasCloudEmailAccess(): boolean {
    return this.memberEmails.size > 0;
  }

  /**
   * Whether some Rome Cloud sign-in can be let in: a member is invited or the
   * guardian's seat has an email.
   */
  hasSignInEmails(): boolean {
    return this.memberEmails.size > 0 || this.guardianEmail !== null;
  }

  /** Whether a Rome Cloud sign-in with `email` is a member's or the guardian's seat's. */
  isCloudEmailAllowed(email: string): boolean {
    const normalized = normalizeVisitorEmail(email);
    return (
      normalized !== null &&
      (this.memberEmails.has(normalized) || normalized === this.guardianEmail)
    );
  }

  /** Replaces the members' emails, keeping the guardian's. */
  setCloudEmailAccess(emails: Iterable<string>): void {
    this.memberEmails = normalizedSet(emails);
  }

  /** Replaces the members' emails and the guardian's with those in `db`. */
  async load(db: DrizzleDb): Promise<void> {
    const members = await memberEmails(memberContext(db));
    const guardian = await guardianSeatEmail(db);
    this.memberEmails = normalizedSet(members);
    this.guardianEmail = guardian;
  }
}

function normalizedSet(emails: Iterable<string>): Set<string> {
  return new Set(
    Array.from(emails, normalizeVisitorEmail).filter((email): email is string => email !== null),
  );
}
