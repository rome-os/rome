import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "../../logger.js";
import { withoutSessionActor } from "../../lib/session-actor.js";
import { createWebhookAuth } from "../middleware/webhook-auth.js";
import {
  InvalidAppApiPathError,
  decodeAppApiPathSegment,
  parseWebhookRequestBody,
  toWebhookInvocationResponse,
  toWebhookInvocationStatus,
} from "../helpers.js";
import type { ActionEngine } from "../../actions/engine.js";
import type { ActionResult } from "../../actions/types.js";
import type { WebhookInvocationsRepository } from "../../db/repositories/webhook-invocations.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:webhooks");
const WEBHOOK_CALLBACK_TIMEOUT_MS = 5_000;

async function processWebhookInvocation(params: {
  executionId: string;
  actionName: string;
  args: Record<string, unknown>;
  callbackUrl?: string;
  actionEngine: ActionEngine;
  webhookInvocationsRepo: WebhookInvocationsRepository;
}): Promise<void> {
  const { executionId, actionName, args, callbackUrl, actionEngine, webhookInvocationsRepo } =
    params;

  const deliverCallback = async () => {
    if (!callbackUrl) return;
    const invocation = await webhookInvocationsRepo.findByExecutionId(executionId);
    if (!invocation) return;
    const callbackPayload = toWebhookInvocationResponse(invocation);

    const attemptedAt = new Date();
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(callbackPayload),
        signal: AbortSignal.timeout(WEBHOOK_CALLBACK_TIMEOUT_MS),
      });
      await webhookInvocationsRepo.update(executionId, {
        callbackStatus: response.ok ? "succeeded" : "failed",
        callbackAttemptedAt: attemptedAt,
        callbackDeliveredAt: response.ok ? new Date() : null,
        callbackResponseStatus: response.status,
        callbackError: response.ok ? null : `Callback failed with status ${response.status}`,
      });
    } catch (err) {
      await webhookInvocationsRepo.update(executionId, {
        callbackStatus: "failed",
        callbackAttemptedAt: attemptedAt,
        callbackDeliveredAt: null,
        callbackResponseStatus: null,
        callbackError: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await webhookInvocationsRepo.update(executionId, {
    status: "running",
    error: null,
    result: null,
  });

  try {
    const result = await actionEngine.run(actionName, args, {
      initiator: "webhook",
      executionId,
      rootExecutionId: executionId,
    });

    await webhookInvocationsRepo.update(executionId, {
      status: toWebhookInvocationStatus(result),
      result,
      error: result.status === "error" ? result.error : null,
      finishedAt: new Date(),
    });
    await deliverCallback();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: ActionResult = { status: "error", error: message };
    await webhookInvocationsRepo.update(executionId, {
      status: /cancelled/i.test(message) ? "cancelled" : "error",
      result,
      error: message,
      finishedAt: new Date(),
    });
    await deliverCallback();
  }
}

export function webhookRoutes(deps: ApiDeps, webhookApiKey: string | undefined): Hono {
  const app = new Hono();
  const auth = createWebhookAuth(webhookApiKey);

  app.use("/webhooks/*", auth);

  app.get("/webhooks/executions/:id", async (c) => {
    const { webhookInvocationsRepo } = deps;
    let executionId: string;
    try {
      executionId = decodeAppApiPathSegment(c.req.param("id"));
    } catch (err) {
      if (err instanceof InvalidAppApiPathError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    const invocation = await webhookInvocationsRepo.findByExecutionId(executionId);
    if (!invocation) {
      return c.json({ error: "Webhook execution not found", executionId }, 404);
    }
    return c.json(toWebhookInvocationResponse(invocation));
  });

  app.post("/webhooks/:actionName", async (c) => {
    const { actionLoader, webhookInvocationsRepo, actionEngine } = deps;
    let actionName: string;
    try {
      actionName = decodeAppApiPathSegment(c.req.param("actionName"));
    } catch (err) {
      if (err instanceof InvalidAppApiPathError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    const actionConfig = actionLoader.get(actionName);
    if (!actionConfig) {
      return c.json({ error: "Action not found", actionName }, 404);
    }
    if (!actionConfig.webhook) {
      return c.json({ error: "Action is not webhook-enabled", actionName }, 403);
    }
    if (actionConfig.requiresApproval) {
      return c.json(
        {
          error: "Webhook execution does not support approval-gated actions",
          actionName,
        },
        409,
      );
    }

    let parsedBody: { args: Record<string, unknown>; callbackUrl?: string };
    try {
      parsedBody = parseWebhookRequestBody(await c.req.text());
    } catch (err) {
      throw new HTTPException(400, {
        message: err instanceof Error ? err.message : "Invalid webhook body",
      });
    }

    const executionId = randomUUID();
    await webhookInvocationsRepo.createAccepted({
      executionId,
      actionName,
      args: parsedBody.args,
      callbackUrl: parsedBody.callbackUrl,
    });

    // Machine-credential surface: webhook executions record no session actor
    // (NULL) by contract — the X-API-Key caller is a mechanism (that's what
    // `initiator` names), never an accountable session. Enforced here, not by
    // mount order, so it holds even if ambient capture ever covers this
    // router. See docs/concepts/actions.md § Actor.
    void withoutSessionActor(() =>
      processWebhookInvocation({
        executionId,
        actionName,
        args: parsedBody.args,
        callbackUrl: parsedBody.callbackUrl,
        actionEngine,
        webhookInvocationsRepo,
      }),
    ).catch((err) => {
      log.error("webhook execution failed", {
        executionId,
        actionName,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json(
      {
        executionId,
        actionName,
        status: "accepted",
        callbackRequested: !!parsedBody.callbackUrl,
        pollUrl: `/webhooks/executions/${executionId}`,
      },
      202,
    );
  });

  return app;
}
