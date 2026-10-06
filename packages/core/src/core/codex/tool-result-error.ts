// Decides whether a completed codex tool item failed, so the Rome
// `tool_result` carries one `isError` flag instead of each consumer reading
// codex's item fields.

const FAILED_STATUSES = new Set(["failed", "declined"]);

function hasErrorPayload(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * Whether a completed codex tool item failed.
 *
 * - `commandExecution`: a `failed` or `declined` status, or a non-zero `exitCode`.
 * - `fileChange`: a `failed` or `declined` status.
 * - `mcpToolCall`: a `failed` status or a populated `error`.
 * - `dynamicToolCall` (Rome's own tools): Rome's facade result says
 *   `isError`, or codex reports `success: false` or a `failed` status.
 * - Any other item: a `failed` status.
 *
 * `romeToolIsError` is the `isError` of Rome's facade result for a dynamic
 * tool call, when Rome still holds it.
 */
export function codexToolItemIsError(
  item: { type: string; [key: string]: unknown },
  romeToolIsError?: boolean,
): boolean {
  const status = typeof item.status === "string" ? item.status : undefined;
  if (status !== undefined && FAILED_STATUSES.has(status)) return true;
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode;
      return typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0;
    }
    case "mcpToolCall":
      return hasErrorPayload(item.error);
    case "dynamicToolCall":
      return romeToolIsError === true || item.success === false;
    default:
      return false;
  }
}
