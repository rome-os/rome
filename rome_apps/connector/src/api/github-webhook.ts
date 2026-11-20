import { verify } from "@octokit/webhooks-methods";

import type { SubscriptionEvent } from "./normalize.js";

/**
 * Rome's OWN GitHub webhook ingest — no Composio. GitHub signs each delivery
 * with HMAC-SHA256 of the raw body under the hook's shared secret and sends it
 * as `X-Hub-Signature-256: sha256=<hex>`. We verify that here with the secret
 * `connector:connector_github_subscribe` registered on the hook, so a forged delivery to
 * the public webhook URL can never inject an event onto Rome's bus.
 *
 * The mirror of `ComposioClient.verifyWebhook` for the GitHub path; kept separate
 * because the two providers use different signature schemes and header names.
 */

/**
 * The connector app-api path GitHub deliveries land on — the same `/webhook`
 * the Composio relay replays into (the handler branches by header), so GitHub
 * hooks ride the existing buffered transport with no new route or relay config.
 */
export const GITHUB_WEBHOOK_PATH = "/api/app-api/connector/webhook";

/**
 * This instance's public GitHub webhook URL, or null when the instance has no
 * public domain (a local self-hosted instance, where GitHub couldn't reach a
 * webhook anyway). Mirrors core's `getConfiguredInstanceOrigin` env logic
 * (`PANTHEON_INSTANCE_ORIGIN`, else `PANTHEON_SLUG` + `PANTHEON_DOMAIN`) — the
 * connector runs in core's process, so the same env is in scope. Kept here, not
 * imported from core, to respect the app↔core boundary.
 */
export function resolveInstanceWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  let origin: string | null = null;
  const explicit = env.PANTHEON_INSTANCE_ORIGIN?.trim();
  if (explicit) {
    try {
      origin = new URL(explicit).origin;
    } catch {
      origin = null;
    }
  } else {
    const slug = env.PANTHEON_SLUG?.trim();
    const domain = env.PANTHEON_DOMAIN?.trim().replace(/^\.+|\.+$/g, "");
    if (slug && domain) origin = `https://${slug}.${domain}`;
  }
  return origin ? `${origin}${GITHUB_WEBHOOK_PATH}` : null;
}

/** The header GitHub stamps the HMAC signature in. */
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
/** The header carrying the event type (`push`, `pull_request`, `issues`, …). */
export const GITHUB_EVENT_HEADER = "x-github-event";
/** The header carrying the unique per-delivery GUID — our dedup id. */
export const GITHUB_DELIVERY_HEADER = "x-github-delivery";

/**
 * GitHub's first delivery on hook creation. It carries no domain event, so the
 * ingest acks it without emitting — the agent's `connector:connector_github_subscribe`
 * already returned success, this just confirms reachability.
 */
export const GITHUB_PING_EVENT = "ping";

/**
 * Verify a GitHub webhook delivery's `X-Hub-Signature-256` against the shared
 * secret, using Octokit's official `@octokit/webhooks-methods` `verify` (a
 * constant-time HMAC-SHA256 over the exact raw bytes GitHub signed). Returns
 * false for a missing/malformed signature rather than throwing, so the caller
 * answers a uniform 401.
 */
export async function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  try {
    return await verify(secret, rawBody, signatureHeader);
  } catch {
    // A malformed signature string makes `verify` throw — treat as unverified.
    return false;
  }
}

/**
 * Build the persisted/published event from a verified GitHub delivery. The
 * `provider` is fixed to `github` and `eventType` comes from the trusted
 * `X-GitHub-Event` header (not the body), so a delivery can't shift the topic on
 * its own — mirroring `normalizeComposioPayload`. The dedup id is GitHub's
 * delivery GUID, and the parsed body is the event payload routines receive.
 */
export function normalizeGithubPayload(
  rawPayload: unknown,
  eventType: string,
  deliveryId: string,
  receivedAtIso: string,
): SubscriptionEvent {
  const data =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  return {
    eventId: deliveryId,
    provider: "github",
    eventType: eventType.toLowerCase(),
    receivedAt: receivedAtIso,
    data,
  };
}
