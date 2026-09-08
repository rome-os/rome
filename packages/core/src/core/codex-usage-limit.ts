// Detects "codex ran out of quota" from a failed turn's error payload.
//
// codex (pinned at @openai/codex 0.153.4) reports turn failures as a v2
// `TurnError { message, codexErrorInfo?, additionalDetails? }`, serialized in
// camelCase. The usage-limit variant of `CodexErrorInfo` is the unit value
// `"usageLimitExceeded"` (NOTE the lowercase first letter — serde
// rename_all="camelCase"). That structured field is the robust, locale- and
// wording-independent signal.
//
// As a secondary, conservative fallback for older/edge builds that omit
// `codexErrorInfo`, we match the canonical English usage-limit phrasings in the
// free-text `message` ("You've hit your usage limit." / "usage limit
// reached"). We deliberately do NOT treat generic rate-limit / 429 / "too many
// requests" wording as a usage-limit: those map to codex's transient
// `serverOverloaded`, which is a retry case, not quota exhaustion.

/** Serialized `CodexErrorInfo::UsageLimitExceeded` (camelCase unit variant). */
export const CODEX_USAGE_LIMIT_ERROR_INFO = "usageLimitExceeded";

/** Conservative secondary matcher over the human-readable `TurnError.message`. */
export const CODEX_USAGE_LIMIT_MESSAGE_RE =
  /\b(?:usage limit (?:reached|exceeded)|hit your usage limit|reached your usage limit)\b/i;

/** Shape of the structured error codex attaches to a failed turn / error notification. */
export interface CodexTurnError {
  message?: unknown;
  codexErrorInfo?: unknown;
  additionalDetails?: unknown;
}

/**
 * Whether a failed codex turn's error denotes an exhausted usage limit (quota),
 * as opposed to any other failure. Accepts the raw `TurnError` object (the
 * `turn.error` on `turn/completed`, or the `error` on an `error` notification);
 * a bare string is treated as message-only and matched against the regex.
 */
export function isCodexUsageLimitError(turnError: unknown): boolean {
  if (turnError == null) return false;
  if (typeof turnError === "string") {
    return CODEX_USAGE_LIMIT_MESSAGE_RE.test(turnError);
  }
  if (typeof turnError !== "object") return false;
  const e = turnError as CodexTurnError;
  // Primary, robust signal: the structured camelCase error code.
  if (e.codexErrorInfo === CODEX_USAGE_LIMIT_ERROR_INFO) return true;
  // Secondary, conservative signal: canonical usage-limit phrasing.
  return typeof e.message === "string" && CODEX_USAGE_LIMIT_MESSAGE_RE.test(e.message);
}

/** Best-effort human-readable message out of a `TurnError`-or-string. */
export function codexTurnErrorMessage(turnError: unknown, fallback: string): string {
  if (typeof turnError === "string" && turnError) return turnError;
  if (turnError && typeof turnError === "object") {
    const msg = (turnError as CodexTurnError).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return fallback;
}
