/** Per-turn terminals — result or error — produced by an agent. Works
 *  generically over `AgentMessage`, `StreamAgentMessage`, and
 *  `TraceBlockDto`, all of which discriminate on `type`. */
export function isTerminalBlock<T extends { type: string }>(
  m: T,
): m is T & { type: "result" | "error" } {
  return m.type === "result" || m.type === "error";
}

/** Transient preview types. Each is followed by the complete block it
 *  previews, so traces, persistence, and accounting skip them. */
export type TransientDeltaType =
  | "text_delta"
  | "thinking_delta"
  | "tool_input_delta"
  | "tool_output_delta";

const TRANSIENT_DELTA_TYPES: ReadonlySet<string> = new Set<TransientDeltaType>([
  "text_delta",
  "thinking_delta",
  "tool_input_delta",
  "tool_output_delta",
]);

/** Whether `m` is a transient preview that a complete block still follows. */
export function isTransientDelta<T extends { type: string }>(
  m: T,
): m is T & { type: TransientDeltaType } {
  return TRANSIENT_DELTA_TYPES.has(m.type);
}
