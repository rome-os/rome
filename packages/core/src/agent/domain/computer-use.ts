import type { RomeToolResult } from "./rome-tools.js";
import type { TurnFacts } from "./turn-facts.js";

export const COMPUTER_USE_ACTION = "core:computer_use";
export const COMPUTER_OPERATIONS = [
  "status",
  "discover",
  "windows",
  "bind",
  "preempt",
  "observe",
  "act",
  "verify",
  "cancel",
  "end",
  "renew",
  "recover",
] as const;
export type ComputerOperation = (typeof COMPUTER_OPERATIONS)[number];

/** The port rechecks admission on each call, including inherited tools in a fork. */
export interface AgentComputerUse {
  permits(turn: TurnFacts): boolean;
  run(
    turn: TurnFacts,
    operation: ComputerOperation,
    input: Record<string, unknown>,
  ): Promise<RomeToolResult>;
  cancelTurn?(sessionId: string, turnId: string): Promise<void>;
  cancelSession?(sessionId: string): Promise<void>;
}

export function declaresComputerUse(actions: readonly string[]): boolean {
  return actions.includes("*") || actions.includes(COMPUTER_USE_ACTION);
}

export function permitsComputerUse(turn: TurnFacts): boolean {
  return (
    declaresComputerUse(turn.actions) &&
    !turn.isSubagent &&
    turn.actor()?.kind === "guardian" &&
    turn.audience() === "private" &&
    turn.live?.() === true
  );
}

export function isComputerTool(name: string): boolean {
  return name.startsWith("computer_");
}

/** Native observations and input text reach the model without entering Rome activity records. */
export function computerToolTraceInput(name: string, input: unknown): unknown {
  return isComputerTool(name) ? { privateComputerUse: true } : input;
}

/** Redacted activity-trace placeholder for computer-use tool results. */
export function computerToolTraceOutput(isError?: boolean): RomeToolResult {
  return {
    content: [{ type: "text", text: "Private computer-use result omitted from activity." }],
    ...(isError === undefined ? {} : { isError }),
  };
}
