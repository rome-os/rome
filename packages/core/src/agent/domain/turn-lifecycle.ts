// What the agent context tells Rome about each turn: it started, it ended, or
// it could not start. Apps hear the first two as their lifecycle hooks
// (docs/concepts/apps.md); each listener decides what it does with them.

import type {
  AgentTurnFinishedEvent,
  AgentTurnOutput,
  AgentTurnRef,
  AgentTurnStartedEvent,
} from "@rome-os/app-runtime";
import { turnStatus, turnStop, type TurnEnding } from "./turn-end.js";

/** A turn that could not start, such as on a model that cannot be resolved. */
export interface AgentTurnFailedBeforeStart {
  turn: AgentTurnRef;
  error: string;
}

/**
 * An ended turn as Rome hears it: the event apps hear, and whether a newer
 * input cut the turn short and took its work on into the next turn, as
 * opposed to its owner's Stop.
 */
export type EndedAgentTurn = AgentTurnFinishedEvent & { handedOn?: boolean };

/**
 * Port. What the agent context tells Rome about each turn. A call never waits
 * on a listener and never fails the turn.
 */
export interface TurnLifecycle {
  started(event: AgentTurnStartedEvent): void;
  ended(event: EndedAgentTurn): void;
  /** No ended call follows, and app hooks never hear of it. */
  couldNotStart(event: AgentTurnFailedBeforeStart): void;
}

/** One listener hears the calls it has. */
export type TurnLifecycleListener = Partial<TurnLifecycle>;

/**
 * What an ended turn reports: its status and output, from how it ended. A
 * result is `partial` when the turn was interrupted and `final` otherwise, and
 * an error carries its failure with the provider that ran it.
 */
export function endedTurn(
  ending: TurnEnding,
  provider: string,
): Pick<AgentTurnFinishedEvent, "status" | "output"> {
  const terminal = ending.terminal;
  const status = turnStatus(ending);
  const stop = turnStop(ending);
  const stopField = stop ? { stop } : {};
  // The deprecated reason: the provider's own, else `interrupted` when Rome stopped the turn.
  const stopReason =
    terminal?.accounting?.stopReason ?? (ending.stoppedByRome ? "interrupted" : undefined);
  let output: AgentTurnOutput;
  if (terminal?.type === "result") {
    output = {
      text: terminal.content,
      structuredOutput: terminal.structuredOutput,
      state: status === "interrupted" ? "partial" : "final",
      terminalKind: "result",
      ...stopField,
      stopReason,
      accounting: terminal.accounting,
    };
  } else if (terminal?.type === "error") {
    output = {
      text: "",
      state: "none",
      terminalKind: "error",
      ...stopField,
      stopReason,
      error: terminal.error,
      accounting: terminal.accounting,
      failure: {
        message: terminal.error,
        provider,
        ...(terminal.code ? { code: terminal.code } : {}),
        ...(terminal.reason ? { reason: terminal.reason } : {}),
        ...(terminal.httpStatus ? { httpStatus: terminal.httpStatus } : {}),
        ...(terminal.providerError ? { providerError: terminal.providerError } : {}),
      },
    };
  } else {
    output = { text: "", state: "none", ...stopField, stopReason };
  }
  return { status, output };
}
