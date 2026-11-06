// Limits on the dashboard allow-list. The instance refuses a save past them, so
// the list it syncs to Rome Cloud always fits what Rome Cloud accepts.

export const DASHBOARD_ACCESS_MAX_EMAILS = 500;
/** The longest address RFC 5321 allows: a 64-character local part, `@`, and a 255-character domain. */
export const DASHBOARD_ACCESS_MAX_EMAIL_LENGTH = 320;

/** The `error` a `PUT /api/dashboard-access` past a limit answers with, under status 400. */
export type DashboardAccessLimitError = "too_many_emails" | "email_too_long";

/**
 * The first limit `emails` breaks, or null. Addresses that differ only in case
 * or surrounding spaces count once, as the saved list stores them once.
 */
export function checkDashboardAccessLimits(
  emails: readonly unknown[],
): DashboardAccessLimitError | null {
  const distinct = new Set<string>();
  for (const email of emails) {
    if (typeof email !== "string") continue;
    const trimmed = email.trim();
    if (trimmed.length > DASHBOARD_ACCESS_MAX_EMAIL_LENGTH) return "email_too_long";
    distinct.add(trimmed.toLowerCase());
  }
  return distinct.size > DASHBOARD_ACCESS_MAX_EMAILS ? "too_many_emails" : null;
}
