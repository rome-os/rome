// Detects "Codex's stored credentials are no longer valid" from a failed turn's
// error payload.
//
// Unlike the quota case (`codex-usage-limit.ts`), codex does NOT attach a
// structured `codexErrorInfo` for an auth failure — the revoked-refresh-token
// condition is surfaced only as free text on the `TurnError.message` (or an
// out-of-turn `error` notification). The canonical wording is:
//
//   "Your access token could not be refreshed because your refresh token was
//    revoked. Please log out and sign in again."
//
// This is OpenAI's own message (see openai/codex#25443, #27896): the refresh
// token rotation invalidated the stored credential server-side, so every future
// API call fails until the guardian re-authenticates. We match the stable
// phrasings rather than the whole sentence so minor wording drift still trips.

import type { CodexTurnError } from "./codex-usage-limit.js";

/**
 * Machine-readable classification stamped onto the terminal `TurnErrorEvent.code`
 * when a codex turn fails because its credentials were revoked. Consumers can
 * use this instead of re-matching the human-readable text.
 */
export const CODEX_AUTH_REVOKED_CODE = "auth_revoked" as const;

/** Matches the canonical revoked-refresh-token / failed-refresh phrasings. */
export const CODEX_AUTH_REVOKED_MESSAGE_RE =
  /\brefresh token (?:was|is|has been) revoked\b|\baccess token could not be refreshed\b|\blog out and sign in again\b/i;

/**
 * Whether a failed codex turn's error denotes revoked credentials (a refresh
 * token the server no longer honors), as opposed to any other failure. Accepts
 * the raw `TurnError` object (the `turn.error` on `turn/completed`, or the
 * `error` on an `error` notification); a bare string is matched as message-only.
 */
export function isCodexAuthRevokedError(turnError: unknown): boolean {
  if (turnError == null) return false;
  if (typeof turnError === "string") {
    return CODEX_AUTH_REVOKED_MESSAGE_RE.test(turnError);
  }
  if (typeof turnError !== "object") return false;
  const e = turnError as CodexTurnError;
  return typeof e.message === "string" && CODEX_AUTH_REVOKED_MESSAGE_RE.test(e.message);
}
