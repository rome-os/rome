import { z } from "zod";
import type { ActionRegistry, ActionResult } from "../apps/actions/types.js";
import { callMain } from "../apps/actions/worker-rpc-client.js";
import type { WorkerRpcHandler } from "../apps/actions/worker-rpc.js";
import { parseWorkerCallParams } from "../lib/worker-call-params.js";
import { withForwardedApprovalId } from "../connections/approved-send.js";
import {
  GMAIL_READ_ACTION,
  GMAIL_SEND_ACTION,
  registerGmailActions,
} from "../connections/gmail/actions.js";
import {
  OUTLOOK_READ_ACTION,
  OUTLOOK_SEND_ACTION,
  registerOutlookActions,
} from "../connections/outlook/actions.js";

const METHOD = "mail.execute";
const paramsSchema = z
  .object({
    name: z.enum([GMAIL_READ_ACTION, GMAIL_SEND_ACTION, OUTLOOK_READ_ACTION, OUTLOOK_SEND_ACTION]),
    args: z.record(z.string(), z.unknown()),
    approvalId: z.string().min(1).optional(),
  })
  .strict();

type Call = (
  method: string,
  params: unknown,
  options?: { timeoutMs: number },
) => Promise<ActionResult>;

/** Workers share the native mail action contracts and approval gate, but never the mail credentials. */
export function registerMailActionProxies(
  actions: Pick<ActionRegistry, "register">,
  call: Call = callMain,
): void {
  const options = {
    forward: (name: string, args: Record<string, unknown>, approvalId?: string) =>
      call(METHOD, { name, args, ...(approvalId ? { approvalId } : {}) }, { timeoutMs: 65_000 }),
  };
  registerGmailActions(actions, undefined, options);
  registerOutlookActions(actions, undefined, options);
}

/** Only a native mail action's body reaches the credential-bearing main implementation. */
export function mailWorkerCalls(
  actions: Pick<ActionRegistry, "get">,
): Record<string, WorkerRpcHandler> {
  return {
    [METHOD]: async (params, caller) => {
      const { name, args, approvalId } = parseWorkerCallParams(METHOD, paramsSchema, params);
      // Caller metadata is only a routing check. Main independently claims
      // the exact resolved approval before a send, even if a worker forges it.
      if (caller?.callerActionName !== name) {
        return { status: "error", error: "Mail calls require the native mail action context." };
      }
      const action = actions.get(name);
      if (!action) return { status: "error", error: "Mail service unavailable." };
      return withForwardedApprovalId(approvalId, () => action.execute(args));
    },
  };
}
