// How a whole turn ended. The words are in docs/concepts/sessions.md (Turn):
// a turn ends completed, failed, stopped or abandoned. Reading a provider's own
// end signal is that provider's adapter's.

import type {
  AgentAccounting,
  AgentStop,
  AgentStopReason,
  AgentTurnStatus,
  TurnErrorEvent,
  TurnResultEvent,
} from "@rome-os/app-runtime";

/** What closed the turn. The provider's own stop is read from the terminal event's accounting. */
export interface TurnEnding {
  terminal?: TurnResultEvent | TurnErrorEvent;
  /** The user's Stop, or a `now` input superseding the turn. */
  stoppedByRome: boolean;
}

/**
 * The turn's stop reason. A Rome stop or the provider's own stop gives
 * `interrupted`. Otherwise an error event gives `error`, even when the model
 * itself finished, and a result never gives `error`: a provider error that
 * still arrived as a result gives `other`. Undefined only when Rome did not
 * stop the turn and no terminal event closed it.
 */
export function turnStop(ending: TurnEnding): AgentStop | undefined {
  const stop = providerStop(ending.terminal?.accounting);
  const withProviderRaw = (reason: AgentStopReason): AgentStop =>
    stop?.raw ? { reason, raw: stop.raw } : { reason };
  if (ending.stoppedByRome || stop?.reason === "interrupted") return withProviderRaw("interrupted");
  if (ending.terminal?.type === "error") return withProviderRaw("error");
  if (stop) return stop.reason === "error" ? withProviderRaw("other") : stop;
  if (ending.terminal?.type === "result") return { reason: "completed" };
  return undefined;
}

/**
 * The turn's status. A Rome stop or the provider's own stop makes it
 * `interrupted` (stopped), then an error event `error` (failed), then a result
 * `completed`. `stopped` (abandoned) only when neither a stop nor a terminal
 * event closed it, so a turn with a terminal event is never `stopped`.
 */
export function turnStatus(
  ending: TurnEnding & { terminal: TurnResultEvent | TurnErrorEvent },
): Exclude<AgentTurnStatus, "stopped">;
export function turnStatus(ending: TurnEnding): AgentTurnStatus;
export function turnStatus(ending: TurnEnding): AgentTurnStatus {
  if (turnStop(ending)?.reason === "interrupted") return "interrupted";
  if (ending.terminal?.type === "error") return "error";
  if (ending.terminal?.type === "result") return "completed";
  return "stopped";
}

/** The accounting's stop, reading the deprecated string when `stop` is absent. */
function providerStop(accounting: AgentAccounting | undefined): AgentStop | undefined {
  return accounting?.stop ?? stopFromDeprecatedReason(accounting?.stopReason);
}

/**
 * The deprecated `stopReason` string, Rome's frozen vocabulary as every adapter
 * wrote it: Anthropic's `stop_reason` values, Codex's `end_turn` and `error`,
 * and `interrupted`. Turn middleware, test fakes and blocks stored before
 * `stop` existed still carry it.
 */
function stopFromDeprecatedReason(stopReason: string | undefined): AgentStop | undefined {
  if (stopReason === undefined) return undefined;
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return { reason: "completed", raw: stopReason };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { reason: "max_tokens", raw: stopReason };
    case "refusal":
      return { reason: "refusal", raw: stopReason };
    case "interrupted":
      return { reason: "interrupted", raw: stopReason };
    case "error":
      return { reason: "error", raw: stopReason };
    default:
      return { reason: "other", raw: stopReason };
  }
}
