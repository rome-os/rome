/**
 * A user-facing message for a failed response.
 *
 * Only the server's structured fields are used. A body carrying none of them
 * was not written for a human — a 500 answering with an HTML error page or a
 * stack trace must never be rendered verbatim — so the caller's `fallback`
 * stands in.
 *
 * This used to end with a `response.text()` fallback, which was unreachable:
 * `response.json()` consumes the body even when parsing fails, so the read that
 * followed it always threw and returned `fallback` anyway.
 */
export async function getApiErrorMessage(response: Response, fallback: string): Promise<string> {
  return apiErrorMessageFrom(await response.json().catch(() => null), fallback);
}

/** The same message, for a caller that has already parsed the body to read its error code. */
export function apiErrorMessageFrom(data: unknown, fallback: string): string {
  const body = data as { detail?: unknown; message?: unknown; error?: unknown } | null;
  if (typeof body?.detail === "string" && body.detail.trim()) return body.detail.trim();
  if (typeof body?.message === "string" && body.message.trim()) return body.message.trim();
  if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
  return fallback;
}
