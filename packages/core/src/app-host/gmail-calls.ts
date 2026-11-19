import { z } from "zod";
import type { ActionRegistry, ActionResult } from "../apps/actions/types.js";
import { callMain } from "../apps/actions/worker-rpc-client.js";
import type { WorkerRpcHandler } from "../apps/actions/worker-rpc.js";
import { parseWorkerCallParams } from "../lib/worker-call-params.js";
import {
  GMAIL_READ_ACTION,
  GMAIL_SEND_ACTION,
  registerGmailActions,
} from "../connections/gmail/actions.js";

const METHOD = "gmail.execute";
const paramsSchema = z
  .object({
    name: z.enum([GMAIL_READ_ACTION, GMAIL_SEND_ACTION]),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

type Call = (
  method: string,
  params: unknown,
  options?: { timeoutMs: number },
) => Promise<ActionResult>;

/** Workers share the native action contracts and approval gate, but never the Google credential. */
export function registerGmailActionProxies(
  actions: Pick<ActionRegistry, "register">,
  call: Call = callMain,
): void {
  registerGmailActions(actions, undefined, (name, args) =>
    call(METHOD, { name, args }, { timeoutMs: 65_000 }),
  );
}

/** Only a native Gmail action's body reaches the credential-bearing main implementation. */
export function gmailWorkerCalls(
  actions: Pick<ActionRegistry, "get">,
): Record<string, WorkerRpcHandler> {
  return {
    [METHOD]: async (params, caller) => {
      const { name, args } = parseWorkerCallParams(METHOD, paramsSchema, params);
      // Core captures this at the IPC boundary. An app cannot skip the native
      // send action's requiresApproval gate by calling this service itself.
      if (caller?.callerActionName !== name) {
        return { status: "error", error: "Gmail calls require the native Gmail action context." };
      }
      const action = actions.get(name);
      if (!action) return { status: "error", error: "Gmail service unavailable." };
      return action.execute(args);
    },
  };
}
