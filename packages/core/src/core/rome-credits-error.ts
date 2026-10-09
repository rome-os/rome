import { classifyCodexErrorInfo } from "./codex-error-info.js";

export const ROME_CREDITS_USED_UP_MESSAGE = "Rome credits are used up.";

/** #124's 402 response survives Codex as this message even when it strips error.code. */
const ROME_CREDITS_USED_UP_MESSAGE_RE = /\bRome credits are used up\b/i;
const PAYMENT_REQUIRED_RE = /\b(?:status\s+)?402\s+Payment Required\b/i;

/** #124 returns a 402 body Codex may retain as a code or as its message. */
export function isRomeCreditsExhaustedError(error: unknown): boolean {
  const seen = new Set<object>();
  const strings: string[] = [];
  const collectStrings = (value: unknown, depth = 0): void => {
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (!value || typeof value !== "object" || depth >= 4 || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) collectStrings(child, depth + 1);
  };
  collectStrings(error);
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
  const seen = new Set<object>();
  const visit = (value: unknown, depth = 0): boolean => {
    if (typeof value === "string")
      return value.includes("model_not_allowed") || MODEL_NOT_SERVED_MESSAGE_RE.test(value);
    if (!value || typeof value !== "object" || depth >= 4 || seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some((child) => visit(child, depth + 1));
  };
  return visit(error);
}

const MODEL_NOT_SERVED_MESSAGE_RE =
  /\bThis model is not (?:available from Rome credits|enabled for your account)\b/i;
