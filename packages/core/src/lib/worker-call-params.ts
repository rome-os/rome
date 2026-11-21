import type { z } from "zod";

/**
 * Parses the params of a call an app's worker makes on the main process. A
 * mismatch throws `<method>: invalid params — <issues>`, the message workers
 * see for every such call.
 */
export function parseWorkerCallParams<T extends z.ZodType>(
  method: string,
  schema: T,
  params: unknown,
): z.infer<T> {
  const result = schema.safeParse(params);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`${method}: invalid params — ${issues}`);
}
