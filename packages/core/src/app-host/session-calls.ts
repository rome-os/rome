// The calls an app's worker makes on the main process to continue a session
// or push a notification. Both need main-process state: the agent sessions and
// connected accounts a turn runs and replies through, and the instance token a
// push is sent with, which never leaves the main process.

import { z } from "zod";
import type { ConciergeOwner } from "../webchat/owner.js";
import { parseWorkerCallParams } from "../lib/worker-call-params.js";
import type { SendOutcome, SystemNotifyContent } from "../instance/notify-client.js";
import type { IpcCallContext } from "../apps/actions/ipc.js";
import type { MainBackendTurnRunner } from "./backend-turn.js";
import { actionCaller, sendForCaller } from "./caller-notify.js";

const SessionContinueParams = z.object({
  agentName: z.string().min(1),
  sessionId: z.string().min(1),
  channel: z.string().min(1),
  threadId: z.string().min(1),
  channelUserId: z.string().optional(),
  prompt: z.string(),
  ownerKey: z.string().optional(),
});

// An optional sender-supplied body. `{}` (the legacy no-arg call) is
// valid; a present body must be a string. `.strict()` so an unknown key on this
// internal wire contract surfaces as an error rather than being silently
// stripped — a typo'd param must not degrade to the default alert unnoticed.
const NotifySendParams = z.object({ body: z.string().optional() }).strict();

export interface SessionWorkerCallsDeps {
  /** Runs the turn the `resume_session` action asks for, and delivers its reply. */
  backendTurnRunner: Pick<MainBackendTurnRunner, "runAndDeliver">;
  /** Sends a push through Rome Cloud's `/api/notify` with the instance token. */
  notify: { send(content?: SystemNotifyContent): Promise<SendOutcome> };
  /** The one person a dashboard chat is private to, or null for a shared chat: a push it calls for rings them. */
  privateOwnerOf: (chatId: string) => Promise<ConciergeOwner | null>;
}

/** The session and notification calls an app's worker makes, keyed by method name. */
export function sessionWorkerCalls(
  deps: SessionWorkerCallsDeps,
): Record<string, (params: unknown, context?: IpcCallContext) => Promise<unknown>> {
  return {
    "session.continue": async (params, context) => {
      const turn = parseWorkerCallParams("session.continue", SessionContinueParams, params);
      // The woken turn acts for the person of the action that woke it, as the
      // IPC boundary captured them, such as the person whose reminder fired.
      const actor = context?.callerActionContext?.actor;
      await deps.backendTurnRunner.runAndDeliver(turn, actor ? { actor } : undefined);
      return { ok: true };
    },
    "notify.send": async (params, context) => {
      // The only wire param is the optional body. An absent body is
      // `send(undefined)`, not `send({})`. Whose phone it rings comes from the
      // caller the IPC boundary captured.
      const { body } = parseWorkerCallParams("notify.send", NotifySendParams, params);
      return sendForCaller(
        deps.notify,
        deps.privateOwnerOf,
        actionCaller(context?.callerActionContext),
        body !== undefined ? { body } : undefined,
      );
    },
  };
}
