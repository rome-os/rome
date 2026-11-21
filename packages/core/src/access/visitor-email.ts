const SAFE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims and lowercases a visitor's email, or returns null when it is not one. */
export function normalizeVisitorEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (!SAFE_EMAIL_RE.test(normalized)) return null;
  return normalized;
}
