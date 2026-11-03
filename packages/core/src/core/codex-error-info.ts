// Classifies a failed codex turn by its structured `codexErrorInfo`.
//
// `codexErrorInfo` is codex's externally tagged `CodexErrorInfo` enum,
// serialized in camelCase: a string for unit variants (`"badRequest"`) or a
// one-key object for struct variants
// (`{ "httpConnectionFailed": { "httpStatusCode": 503 } }`).
// Usage-limit and auth failures are classified separately
// (codex-usage-limit.ts, codex-auth-revoked.ts) because they also update
// provider state.

import type { AgentErrorCode } from "@rome-os/app-runtime";
import type { CodexTurnError } from "./codex-usage-limit.js";

const TRANSIENT_VARIANTS = new Set([
  "rateLimitExceeded",
  "serverOverloaded",
  "internalServerError",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);

export interface CodexErrorInfoClassification {
  code?: Extract<AgentErrorCode, "context_window_exceeded" | "transient" | "invalid_request">;
  httpStatus?: number;
}

function variantOf(info: unknown): { name: string; fields?: Record<string, unknown> } | null {
  if (typeof info === "string") return { name: info };
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const entries = Object.entries(info);
  if (entries.length !== 1) return null;
  const [name, fields] = entries[0];
  return {
    name,
    fields: fields && typeof fields === "object" ? (fields as Record<string, unknown>) : undefined,
  };
}

/** Error code and HTTP status for a codex `TurnError`, when its variant maps to one. */
export function classifyCodexErrorInfo(turnError: unknown): CodexErrorInfoClassification {
  if (!turnError || typeof turnError !== "object") return {};
  const variant = variantOf((turnError as CodexTurnError).codexErrorInfo);
  if (!variant) return {};
  const status = variant.fields?.httpStatusCode;
  const httpStatus =
    typeof status === "number" && Number.isInteger(status) && status > 0 ? status : undefined;
  const withStatus = (code: CodexErrorInfoClassification["code"]): CodexErrorInfoClassification =>
    httpStatus === undefined ? { code } : { code, httpStatus };
  if (variant.name === "contextWindowExceeded") return withStatus("context_window_exceeded");
  if (variant.name === "badRequest") return withStatus("invalid_request");
  if (TRANSIENT_VARIANTS.has(variant.name)) return withStatus("transient");
  return httpStatus === undefined ? {} : { httpStatus };
}
