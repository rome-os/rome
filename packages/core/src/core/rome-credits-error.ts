import { classifyCodexErrorInfo } from "./codex-error-info.js";

export const ROME_CREDITS_USED_UP_MESSAGE = "Rome credits are used up.";

/** #124 returns this code inside Codex's 402 gateway failure payload. */
export function isRomeCreditsExhaustedError(error: unknown): boolean {
  if (classifyCodexErrorInfo(error).httpStatus !== 402) return false;
  const seen = new Set<object>();
  const containsCode = (value: unknown, depth = 0): boolean => {
    if (typeof value === "string") return value.includes("insufficient_credits");
    if (!value || typeof value !== "object" || depth >= 4 || seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some((child) => containsCode(child, depth + 1));
  };
  return containsCode(error);
}
