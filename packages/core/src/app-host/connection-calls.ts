// What Connections offers apps. An app's action worker runs in its own
// process, and the connections live in the main process, so the worker reaches
// them through these calls.

import { z } from "zod";
import { parseWorkerCallParams } from "../lib/worker-call-params.js";
import type {
  AppConnectionBrokerPort,
  AppConnectionBrokerResult,
  AppConnectionInvocationContext,
} from "../connections/app-connections.js";
import type { EmailInboundResult } from "../connections/kinds/email/email-control.js";
import type { ConnectionRegistry } from "../connections/registry.js";

const ListParams = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(50).optional(),
  })
  .strict();
const IdentityParams = z
  .object({ connectionId: z.string().min(1), identity: z.string().min(1) })
  .strict();
const OperationsParams = IdentityParams.extend({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
}).strict();
const InvokeParams = IdentityParams.extend({
  operation: z.string().min(1),
  input: z.unknown().optional(),
  requestId: z.string().optional(),
}).strict();

const EmailIngestInboundParams = z.object({
  rawBody: z.string(),
  signature: z.string(),
});

/** The action behind a worker's call, as the worker boundary captured it. */
export interface WorkerCaller {
  callerActionName?: string;
  callerActionContext?: AppConnectionInvocationContext;
}

export interface ConnectionWorkerCallsDeps {
  appConnections: AppConnectionBrokerPort;
  /** The app that owns an action, or null for an action no app owns. */
  appIdForAction: (actionName: string) => string | null;
  connectionRegistry: Pick<ConnectionRegistry, "ingest">;
  /** The connection inbound email arrives on, or undefined when there is none. */
  emailConnectionId: () => string | undefined;
}

// An app connection call answers bad params with a result, not a throw, so
// the app sees the same error shape as any other refusal.
function parseAppConnectionParams<T extends z.ZodType>(
  method: string,
  schema: T,
  params: unknown,
): AppConnectionBrokerResult<z.infer<T>> {
  try {
    return { ok: true, value: parseWorkerCallParams(method, schema, params) };
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "The App connection request is invalid.",
        retryable: false,
      },
    };
  }
}

/** The connection calls an app's worker makes, keyed by method name. */
export function connectionWorkerCalls(
  deps: ConnectionWorkerCallsDeps,
): Record<string, (params: unknown, caller?: WorkerCaller) => Promise<unknown>> {
  const appOf = (caller?: WorkerCaller) =>
    caller?.callerActionName ? deps.appIdForAction(caller.callerActionName) : null;
  const accessDenied = {
    ok: false,
    error: {
      code: "access_denied",
      message: "Connection access requires an App-owned action context.",
      retryable: false,
    },
  } as const;

  return {
    "connections.app.list": async (params, caller) => {
      const appId = appOf(caller);
      if (!appId) return accessDenied;
      const parsed = parseAppConnectionParams("connections.app.list", ListParams, params);
      if (!parsed.ok) return parsed;
      return await deps.appConnections.list(appId, parsed.value);
    },
    "connections.app.describe": async (params, caller) => {
      const appId = appOf(caller);
      if (!appId) return accessDenied;
      const parsed = parseAppConnectionParams("connections.app.describe", IdentityParams, params);
      if (!parsed.ok) return parsed;
      return await deps.appConnections.describe(appId, parsed.value);
    },
    "connections.app.operations": async (params, caller) => {
      const appId = appOf(caller);
      if (!appId) return accessDenied;
      const parsed = parseAppConnectionParams(
        "connections.app.operations",
        OperationsParams,
        params,
      );
      if (!parsed.ok) return parsed;
      return await deps.appConnections.operations(appId, parsed.value);
    },
    "connections.app.invoke": async (params, caller) => {
      const appId = appOf(caller);
      if (!appId) return accessDenied;
      const parsed = parseAppConnectionParams("connections.app.invoke", InvokeParams, params);
      if (!parsed.ok) return parsed;
      return await deps.appConnections.invoke(appId, parsed.value, caller?.callerActionContext);
    },
    "channels.email.ingestInbound": async (params): Promise<EmailInboundResult> => {
      const { rawBody, signature } = parseWorkerCallParams(
        "channels.email.ingestInbound",
        EmailIngestInboundParams,
        params,
      );
      const emailId = deps.emailConnectionId();
      if (!emailId) return { status: "skipped", reason: "channel_inactive" };
      return (await deps.connectionRegistry.ingest(emailId, {
        rawBody,
        signature,
      })) as EmailInboundResult;
    },
  };
}
