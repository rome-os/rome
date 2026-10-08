// Maps each provider's native end-of-run signal onto the shared
// `AgentStopReason` vocabulary. Every provider mapping lives here so the
// rest of core, the web client, and apps read only `stop.reason`.

import type { AgentAccounting, AgentStop, AgentStopReason } from "../types.js";

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

/**
 * Stop for a Codex app-server turn from its `turn/completed` status
 * (`completed`, `interrupted`, `failed`, or `inProgress`). Codex reports no
 * output-limit status at turn level, so it never yields `max_tokens`.
 *
 * `failed` is true when the turn ends in an error. The stop is then `error`
 * whatever the status, and the status stays as `raw`, the way `anthropicStop`
 * reports a failed Claude result. `isInterruptedAccounting` reads an
 * `interrupted` stop as an interrupted turn, so the accounting on an error
 * never carries one.
 */
export function codexStop(status: string | undefined, failed = false): AgentStop {
  if (failed) return status ? { reason: "error", raw: status } : { reason: "error" };
  switch (status) {
    case "completed":
      return { reason: "completed", raw: status };
    case "interrupted":
      return { reason: "interrupted", raw: status };
    case "failed":
      return { reason: "error", raw: status };
    default:
      return status ? { reason: "other", raw: status } : { reason: "other" };
  }
}

/**
 * Stop for accounting that carries only the deprecated `stopReason` string,
 * as written by turn middleware, test fakes, and blocks persisted before
 * `stop` existed.
 */
export function stopFromLegacyReason(stopReason: string | undefined): AgentStop | undefined {
  if (stopReason === undefined) return undefined;
  switch (stopReason) {
    case "interrupted":
      return { reason: "interrupted", raw: stopReason };
    case "error":
      return { reason: "error", raw: stopReason };
    default:
      return { reason: fromAnthropicStopReason(stopReason), raw: stopReason };
  }
}

/** The accounting's stop, reading the deprecated string when `stop` is absent. */
export function accountingStop(accounting: AgentAccounting | undefined): AgentStop | undefined {
  return accounting?.stop ?? stopFromLegacyReason(accounting?.stopReason);
}

/** True when the accounting says the run was interrupted. */
export function isInterruptedAccounting(accounting: AgentAccounting | undefined): boolean {
  return accountingStop(accounting)?.reason === "interrupted";
}

/**
 * The stop reported for a whole turn, kept consistent with the turn's status.
 * A user interrupt wins over what the provider reported. An `error` terminal
 * reports `error` even when the model itself finished (for example, when Rome
 * rejected its structured output). A `result` terminal never reports `error`:
 * a provider error that still arrived as a result reports `other`. An
 * interrupted turn reports `interrupted` even without a terminal block.
 * Returns undefined only when the turn was neither interrupted nor produced a
 * terminal block.
 */
export function resolveTurnStop(params: {
  accounting: AgentAccounting | undefined;
  terminalKind: "result" | "error" | undefined;
  interrupted: boolean;
}): AgentStop | undefined {
  const stop = accountingStop(params.accounting);
  const withProviderRaw = (reason: AgentStopReason): AgentStop =>
    stop?.raw ? { reason, raw: stop.raw } : { reason };
  if (params.interrupted || stop?.reason === "interrupted") return withProviderRaw("interrupted");
  if (params.terminalKind === "error") return withProviderRaw("error");
  if (stop) return stop.reason === "error" ? withProviderRaw("other") : stop;
  if (params.terminalKind === "result") return { reason: "completed" };
  return undefined;
}
