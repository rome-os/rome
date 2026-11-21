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

export function actionError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ActionResponse {
  let metadata: Record<string, unknown> | undefined;
  if (details) {
    try {
      if (Object.keys(details).length > 0 && Buffer.byteLength(JSON.stringify(details)) <= 8192)
        metadata = details;
    } catch {
      // Diagnostics cannot prevent the operation's failure from reaching its caller.
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
