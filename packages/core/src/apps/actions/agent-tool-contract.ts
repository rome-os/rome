// For the tests of core's agent tools (agent-tool.ts): the call a tool's own
// tests make, so a tool's tests cover only its operation.

import type { Action, ActionResult, PreviewPayload } from "@rome-os/app-runtime";
import type { AgentTool, ToolTurn } from "./agent-tool.js";
import { actionExecutionContext } from "./context.js";

/** The guardian's own message in one of their chats. */
export const GUARDIAN_TURN: ToolTurn = {
  actor: { kind: "guardian", userId: "guardian", via: "cookie" },
  audience: "private",
  channelContext: { channel: "webchat", threadId: "guardian-chat" },
};

/** The action core registers for `tool` over `deps`. */
export function actionOf<D>(tool: AgentTool<D>, deps: D): Action {
  return tool.action(deps);
}

/** Calls `tool` over `deps` as the action core registers, for `turn`. */
export function callTool<D>(
  tool: AgentTool<D>,
  deps: D,
  input: Record<string, unknown>,
  turn: ToolTurn = GUARDIAN_TURN,
): Promise<ActionResult> {
  const action = actionOf(tool, deps);
  return asTurn(turn, () => action.execute(input));
}

/** The approval card `tool` shows for `input` in `turn`, or undefined for a
 * call that runs without the guardian's approval. */
export async function approvalOf<D>(
  tool: AgentTool<D>,
  deps: D,
  input: Record<string, unknown>,
  turn: ToolTurn = GUARDIAN_TURN,
): Promise<PreviewPayload | undefined> {
  const action = actionOf(tool, deps);
  if (!action.config.requiresApproval) return undefined;
  return asTurn(turn, async () => action.preview?.(input));
}

function asTurn<T>(turn: ToolTurn, fn: () => Promise<T>): Promise<T> {
  return actionExecutionContext.run(
    { executionId: "exec", rootExecutionId: "exec", initiator: "test", ...turn },
    fn,
  );
}
