export interface ActionRequest {
  type: "request";
  action: string;
  args: unknown;
}

export type ActionResponse =
  | { type: "response"; ok: true; result: unknown }
  | {
      type: "response";
      ok: false;
      error: { code: string; message: string; details?: Record<string, unknown> };
    };

/** Response of a binary request. The body holds output bytes and is empty for every failure. */
export interface BinaryActionResult {
  response: ActionResponse;
  body: Uint8Array;
}

const SAFETY_DETAIL_KEYS = [
  "effectStatus",
  "terminalCause",
  "stopConfirmed",
  "replayAllowed",
] as const;

function pickSafetyDetails(details: Record<string, unknown>): Record<string, unknown> | undefined {
  const safe: Record<string, unknown> = {};
  for (const key of SAFETY_DETAIL_KEYS) {
    const value = details[key];
    if (typeof value === "string" || typeof value === "boolean") safe[key] = value;
  }
  if (Object.keys(safe).length === 0) return undefined;
  return Buffer.byteLength(JSON.stringify(safe)) <= 8192 ? safe : undefined;
}

export function actionError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ActionResponse {
  let metadata: Record<string, unknown> | undefined;
  if (details && Object.keys(details).length > 0) {
    try {
      if (Buffer.byteLength(JSON.stringify(details)) <= 8192) metadata = details;
      else metadata = pickSafetyDetails(details);
    } catch {
      // Diagnostics cannot prevent the operation's failure from reaching its caller,
      // but replay-safety signals must survive oversized or circular diagnostic bags.
      metadata = pickSafetyDetails(details);
    }
  }
  return {
    type: "response",
    ok: false,
    error: { code, message, ...(metadata ? { details: metadata } : {}) },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseResponse(value: unknown): ActionResponse | null {
  if (!isRecord(value) || value.type !== "response") return null;
  if (value.ok === true && Object.hasOwn(value, "result"))
    return { type: "response", ok: true, result: value.result };
  if (
    value.ok === false &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  )
    return actionError(
      value.error.code,
      value.error.message,
      isRecord(value.error.details) ? value.error.details : undefined,
    );
  return null;
}
