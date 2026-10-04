// Best-effort detection of "Claude is out of quota" from a failed turn's error
// text, so the codex→Claude fallback can recognize Claude's own usage limit
// reactively (the same way codex is detected) instead of probing usage upfront.
//
// Unlike codex — which exposes a structured `codexErrorInfo: "usageLimitExceeded"`
// — the Claude Agent SDK surfaces failures as free text (in the SDK result's
// `errors` or a thrown error). So we match the known subscription usage-cap
// phrasings conservatively and, deliberately, do NOT treat a generic transient
// rate-limit / 429 / "overloaded" as a usage cap (those are retryable, not
// exhaustion). A miss simply forwards Claude's raw error — no worse than before.
//
// TODO: confirm against a real Claude usage-limit error sample and tighten.

export const ANTHROPIC_USAGE_LIMIT_RE =
  /\b(?:usage limit (?:reached|exceeded)|reached your usage limit|hit your (?:usage|session|weekly|opus|sonnet) limit|usage limit\b)/i;

/** Whether a failed Claude turn's error text denotes an exhausted usage limit. */
export function isAnthropicUsageLimitError(message: unknown): boolean {
  return typeof message === "string" && ANTHROPIC_USAGE_LIMIT_RE.test(message);
}
