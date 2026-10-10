import { classifyCodexErrorInfo } from "./codex-error-info.js";

export const ROME_CREDITS_USED_UP_MESSAGE = "Rome credits are used up.";

/** #124's 402 response survives Codex as this message even when it strips error.code. */
const ROME_CREDITS_USED_UP_MESSAGE_RE = /\bRome credits are used up\b/i;
const PAYMENT_REQUIRED_RE = /\b(?:status\s+)?402\s+Payment Required\b/i;

/** Every string in an error, a few levels deep: Codex nests the gateway body. */
function errorStrings(error: unknown): string[] {
  const seen = new Set<object>();
  const strings: string[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (!value || typeof value !== "object" || depth >= 4 || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) collect(child, depth + 1);
  };
  collect(error);
  return strings;
}

/** #124 returns a 402 body Codex may retain as a code or as its message. */
export function isRomeCreditsExhaustedError(error: unknown): boolean {
  const strings = errorStrings(error);
  const has402 =
    classifyCodexErrorInfo(error).httpStatus === 402 ||
    strings.some((value) => PAYMENT_REQUIRED_RE.test(value));
  return (
    has402 &&
    strings.some(
      (value) =>
        value.includes("insufficient_credits") || ROME_CREDITS_USED_UP_MESSAGE_RE.test(value),
    )
  );
}

/**
 * The gateway's 403 for a model its catalog does not serve. Codex may keep the
 * code or only its message.
 */
export function isRomeCreditsModelNotServedError(error: unknown): boolean {
  const strings = errorStrings(error);
  const has403 =
    classifyCodexErrorInfo(error).httpStatus === 403 ||
    strings.some((value) => FORBIDDEN_RE.test(value));
  return (
    has403 &&
    strings.some(
      (value) => value.includes("model_not_allowed") || MODEL_NOT_SERVED_MESSAGE_RE.test(value),
    )
  );
}

const FORBIDDEN_RE = /\b(?:status\s+)?403\s+Forbidden\b/i;
const MODEL_NOT_SERVED_MESSAGE_RE =
  /\bThis model is not (?:available from Rome credits|enabled for your account)\b/i;
