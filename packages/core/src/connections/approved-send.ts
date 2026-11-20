import { AsyncLocalStorage } from "node:async_hooks";
import { actionExecutionContext } from "../apps/actions/context.js";
import type { ActionResult } from "../apps/actions/types.js";

// The approval behind an approved mail send. A worker forwards its approval id
// to main, which claims that exact approval before any send leaves Rome.
const forwardedApproval = new AsyncLocalStorage<{ id?: string }>();

export function withForwardedApprovalId<T>(id: string | undefined, call: () => T): T {
  return forwardedApproval.run({ id }, call);
}

export function approvedSendId(): string | undefined {
  const forwarded = forwardedApproval.getStore();
  if (forwarded) return forwarded.id;
  const initiator = actionExecutionContext.getStore()?.initiator;
  return initiator?.startsWith("approval:") ? initiator.slice("approval:".length) : undefined;
}

/** How a mail action reaches main from a worker, and claims an approval in main. */
export interface ApprovedSendOptions {
  forward?: (
    name: string,
    args: Record<string, unknown>,
    approvalId?: string,
  ) => Promise<ActionResult>;
  claimApprovedSend?: (approvalId: string, argsHash: string) => Promise<boolean>;
}
