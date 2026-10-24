/** Dashboard trace visibility and archival share a seven-day root-session inactivity window. */
export const TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Notifications are real out-of-band conversation messages, not session metadata.
export const TRACE_ACTIVITY_ROLES = ["user", "assistant", "trace", "notification"] as const;

export function sessionTraceCutoff(now = new Date()): Date {
  return new Date(now.getTime() - TRACE_RETENTION_MS);
}

/** Exactly seven idle days on the root session archives its whole tree. */
export function isSessionTraceArchived(
  lastMessageAt: Date,
  cutoff = sessionTraceCutoff(),
): boolean {
  return lastMessageAt.getTime() <= cutoff.getTime();
}
