/** Shared with trace archival: exactly seven days, measured from the trace row's creation. */
export const TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function chatTraceCutoff(now = new Date()): Date {
  return new Date(now.getTime() - TRACE_RETENTION_MS);
}
