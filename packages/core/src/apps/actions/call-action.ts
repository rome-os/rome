import { actionExecutionContext } from "./context.js";
import type { ActionInvocationObserver } from "./runtime-events.js";
import type { ActionResult } from "./types.js";

/**
 * Call another action through ActionEngine from within an action's execute().
 * Makes sure the call is journaled for replay and goes through the approval gate.
 */
export async function callAction(
  actionName: string,
  args: Record<string, unknown>,
  opts?: {
    /** The app making this call, stamped on the callee's context so it can
     * attribute the work (e.g. create_routine → managedBy). Set only by the
     * app-context `runAction` seam; taken straight from `opts` (never the parent
     * store) so it stays per-hop and doesn't leak further down the chain. */
    callerAppId?: string;
    /** Direct observer for this call only. Never inherited by descendants. */
    actionEventObserver?: ActionInvocationObserver;
  },
): Promise<ActionResult> {
  const store = actionExecutionContext.getStore();
  if (!store?.engine) {
    throw new Error("callAction() must be used within ActionEngine.run() context");
  }
  return store.engine.run(
    actionName,
    args,
    {
      rootExecutionId: store.rootExecutionId,
      parentExecutionId: store.executionId,
      parentActionName: store.actionName,
      initiator: store.initiator,
      callerAppId: opts?.callerAppId,
      channelContext: store.channelContext,
      sharedContext: store.sharedContext,
      sessionId: store.sessionId,
      agentName: store.agentName,
      channelThreadKey: store.channelThreadKey,
    },
    undefined,
    opts?.actionEventObserver,
  );
}
