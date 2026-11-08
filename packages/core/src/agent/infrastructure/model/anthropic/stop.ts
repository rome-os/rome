// How a Claude Agent SDK result ended, as Rome's stop reason. How a whole turn
// ended is the agent's rule, in agent/domain/turn-end.ts.

import type { AgentStop, AgentStopReason } from "@rome-os/app-runtime";

/** The fields of a Claude Agent SDK result message that decide its stop. */
export interface AnthropicResultStopInput {
  subtype: string;
  stop_reason?: string | null;
  terminal_reason?: string;
  is_error?: boolean;
}

// SDK `TerminalReason` values that mean the run was cut short by an abort.
const ANTHROPIC_ABORT_TERMINAL_REASONS = new Set(["aborted_streaming", "aborted_tools"]);

function fromAnthropicStopReason(stopReason: string): AgentStopReason {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "completed";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/**
 * Stop for a Claude Agent SDK result. `aborted` is true when Rome itself
 * aborted the run, which takes precedence over what the SDK reports.
 */
export function anthropicStop(result: AnthropicResultStopInput, aborted: boolean): AgentStop {
  const raw = result.stop_reason ?? result.terminal_reason ?? result.subtype;
  const withRaw = (reason: AgentStopReason): AgentStop => (raw ? { reason, raw } : { reason });
  if (
    aborted ||
    (result.terminal_reason !== undefined &&
      ANTHROPIC_ABORT_TERMINAL_REASONS.has(result.terminal_reason))
  ) {
    return withRaw("interrupted");
  }
  if (result.subtype !== "success" || result.is_error === true) {
    // The model's last `stop_reason` (for example `end_turn` or `tool_use`)
    // does not explain a failure; the loop's reason, or else the subtype, does.
    return { reason: "error", raw: result.terminal_reason ?? result.subtype };
  }
  if (result.stop_reason) return withRaw(fromAnthropicStopReason(result.stop_reason));
  // No model stop reason: the loop ended without a final API response, for
  // example a local command. The SDK reports its own loop outcome instead.
  if (result.terminal_reason === undefined || result.terminal_reason === "completed") {
    return withRaw("completed");
  }
  return withRaw("other");
}
