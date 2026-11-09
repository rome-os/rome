import type { AgentLog } from "../domain/agent-log.js";
import type { RomeToolResult } from "../domain/rome-tools.js";

export type RomeToolRunner = (
  name: string,
  input: unknown,
  handler: (args: Record<string, unknown>) => Promise<unknown>,
) => Promise<RomeToolResult>;

/** The try, serialize and wrap every tool shares, bound to a log once. Thrown errors become error results. */
export function romeToolRunner(log: AgentLog): RomeToolRunner {
  return async (name, input, handler) => {
    try {
      const args = (input ?? {}) as Record<string, unknown>;
      log.info("executing Rome tool", { tool: name });
      const output = await handler(args);
      const text = typeof output === "string" ? output : JSON.stringify(output);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Rome tool execution failed", { tool: name, error: message });
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}
