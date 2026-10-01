// PROTOTYPE ONLY. Verbatim copy of `validateRequest` (plus the `InferenceError`
// and `isRecord` it depends on) from amantru/rome-cloud#108 at 4aa7c23,
// packages/pantheon/src/lib/inference/{protocol,types}.ts. The prototype runs
// the gateway's real admission rule against the requests Codex actually sends.

export type InferenceOperation = "responses" | "responses/compact";

export class InferenceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InferenceError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasStoredReference(value: unknown): boolean {
  const remaining: unknown[] = [value];
  while (remaining.length) {
    const item = remaining.pop();
    if (Array.isArray(item)) {
      for (const nested of item) remaining.push(nested);
    } else if (isRecord(item)) {
      if (item.type === "item_reference" || "file_id" in item || "vector_store_ids" in item)
        return true;
      for (const nested of Object.values(item)) remaining.push(nested);
    }
  }
  return false;
}

export function validateRequest(
  value: unknown,
  operation: InferenceOperation,
): Record<string, unknown> {
  const fail = (message: string): never => {
    throw new InferenceError(400, "unsupported_request", message);
  };
  if (!isRecord(value)) return fail("Expected a JSON object.");
  if (typeof value.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.model))
    return fail("A valid model alias is required.");
  if (typeof value.input !== "string" && !Array.isArray(value.input))
    return fail("input must be a string or array.");
  if (value.stream !== undefined && typeof value.stream !== "boolean")
    return fail("stream must be a boolean.");
  if (value.store !== undefined && value.store !== false)
    return fail("Stored responses are not supported; use store=false.");
  if (value.background !== undefined && value.background !== false)
    return fail("Background responses are not supported.");
  if (
    value.previous_response_id != null ||
    value.conversation != null ||
    value.prompt != null ||
    hasStoredReference(value.input)
  )
    return fail("Send conversation items inline; upstream state references are not supported.");
  if (value.service_tier != null && value.service_tier !== "default")
    return fail("Only the default service tier is supported.");
  if (value.tools !== undefined) {
    if (
      !Array.isArray(value.tools) ||
      value.tools.some(
        (tool) => !isRecord(tool) || !["function", "custom"].includes(String(tool.type)),
      )
    )
      return fail("Only client-executed function and custom tools are supported.");
  }
  if (
    value.max_output_tokens !== undefined &&
    (!Number.isSafeInteger(value.max_output_tokens) || (value.max_output_tokens as number) <= 0)
  )
    return fail("max_output_tokens must be a positive integer.");
  if (
    operation === "responses/compact" &&
    (value.stream === true || value.max_output_tokens !== undefined || value.tools !== undefined)
  )
    return fail("Compaction does not accept streaming, tools, or max_output_tokens.");
  return value;
}
