// Detects "Claude's stored credentials are no longer valid" from a failed turn.
//
// The Anthropic provider drives the Claude Agent SDK (`claude` binary); a turn
// whose credential is rejected surfaces as a 401 on the result's `errors` (or a
// thrown stream error). The canonical wording (see Claude Code's error
// reference, code.claude.com/docs/en/errors) is one of:
//
//   "Failed to authenticate. API Error: 401 {... authentication_error ...
//    Invalid authentication credentials}"
//   "OAuth token revoked · Please run /login"
//   "OAuth token has expired · Please run /login"
//
// All of them mean a credential that LOOKS present (so `claude auth status`
// still reports logged in) was rejected server-side — an env API key the API
// no longer accepts, or an OAuth token that was revoked / whose mid-session
// refresh failed. We match those stable phrasings.
//
// Deliberately NOT matched: the bare "Not logged in · Please run /login" text,
// which is a genuine logout rather than a revoked stored credential.

/**
 * Machine-readable classification stamped onto the terminal `TurnErrorEvent.code`
 * when a Claude turn fails because its credentials were rejected. It shares the
 * `"auth_revoked"` value with the Codex detector.
 */
export const ANTHROPIC_AUTH_REVOKED_CODE = "auth_revoked" as const;

/** Matches the canonical invalid-credential / revoked-or-expired-OAuth phrasings. */
export const ANTHROPIC_AUTH_REVOKED_MESSAGE_RE =
  /\binvalid authentication credentials\b|\bauthentication_error\b|\bfailed to authenticate\b|\boauth token (?:was |has been )?(?:revoked|expired)\b|\boauth token has expired\b/i;

/**
 * Whether a failed Claude turn's error denotes rejected credentials (a 401 the
 * server returned for an invalid/expired/revoked credential), as opposed to any
 * other failure. Accepts the SDK's `errors: string[]`, a joined string, an
 * `Error`, or any object carrying a `message`.
 */
export function isAnthropicAuthRevokedError(error: unknown): boolean {
  if (error == null) return false;
  if (typeof error === "string") return ANTHROPIC_AUTH_REVOKED_MESSAGE_RE.test(error);
  if (Array.isArray(error)) return error.some((e) => isAnthropicAuthRevokedError(e));
  if (error instanceof Error) return ANTHROPIC_AUTH_REVOKED_MESSAGE_RE.test(error.message);
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && ANTHROPIC_AUTH_REVOKED_MESSAGE_RE.test(message);
  }
  return false;
}
