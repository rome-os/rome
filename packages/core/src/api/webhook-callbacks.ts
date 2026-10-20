// Sends the callback a webhook invocation requested. The live run and boot recovery
// both send through here. Contract: docs/architecture/api.md#webhook-ingress.
import { toWebhookInvocationResponse } from "./helpers.js";
import type { WebhookInvocationsRepository } from "../db/repositories/webhook-invocations.js";

const WEBHOOK_CALLBACK_TIMEOUT_MS = 5_000;

/**
 * POSTs the invocation's current response to its callback URL once, and records
 * the attempt on the row. Does nothing when the row is missing or has no
 * callback URL. A failed delivery is recorded on the row, not thrown.
 */
export async function deliverWebhookCallback(
  webhookInvocationsRepo: WebhookInvocationsRepository,
  executionId: string,
): Promise<void> {
  const invocation = await webhookInvocationsRepo.findByExecutionId(executionId);
  if (!invocation?.callbackUrl) return;
  const callbackPayload = toWebhookInvocationResponse(invocation);

  const attemptedAt = new Date();
  try {
    const response = await fetch(invocation.callbackUrl, {
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
}

/**
 * Delivers the callback of each listed invocation, one at a time. Pass the ids
 * listUndeliveredCallbacks returns at boot, before the webhook route serves
 * requests, so no live run delivers the same callback concurrently.
 */
export async function deliverWebhookCallbacks(
  webhookInvocationsRepo: WebhookInvocationsRepository,
  executionIds: readonly string[],
): Promise<void> {
  // One at a time, so a backlog of stale rows does not open a burst of requests.
  for (const executionId of executionIds) {
    await deliverWebhookCallback(webhookInvocationsRepo, executionId);
  }
}
