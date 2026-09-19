export interface ActionRequest {
  type: "request";
  action: string;
  args: unknown;
}

export type ActionResponse =
  | { type: "response"; ok: true; result: unknown }
  | { type: "response"; ok: false; error: { code: string; message: string } };

export function actionError(code: string, message: string): ActionResponse {
  return { type: "response", ok: false, error: { code, message } };
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
    return actionError(value.error.code, value.error.message);
  return null;
}
