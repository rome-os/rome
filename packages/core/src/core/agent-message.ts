import type { AgentDeltaEvent } from "@rome-os/app-runtime";

/** Per-turn terminals — result or error — produced by an agent. Works
 *  generically over `AgentMessage`, `StreamAgentMessage`, and
 *  `TraceEventDto`, all of which discriminate on `type`. */
export function isTerminalEvent<T extends { type: string }>(
  m: T,
): m is T & { type: "result" | "error" } {
  return m.type === "result" || m.type === "error";
}

/** Delta event types. Each is followed by the complete block its
 *  deltas build up to, so traces, persistence, and accounting skip them. */
const TRANSIENT_DELTA_TYPE_LIST = [
  "text_delta",
  "thinking_delta",
  "tool_input_delta",
  "tool_output_delta",
] as const satisfies readonly AgentDeltaEvent["type"][];

export type TransientDeltaType = (typeof TRANSIENT_DELTA_TYPE_LIST)[number];

type Assert<T extends true> = T;
type _AllAgentDeltaTypesAreTransient = Assert<
  Exclude<AgentDeltaEvent["type"], TransientDeltaType> extends never ? true : false
>;

const TRANSIENT_DELTA_TYPES: ReadonlySet<string> = new Set(TRANSIENT_DELTA_TYPE_LIST);

/** Whether `m` is a delta event, which a complete block normally follows. */
export function isTransientDelta<T extends { type: string }>(
  m: T,
): m is T & { type: TransientDeltaType } {
  return TRANSIENT_DELTA_TYPES.has(m.type);
}
