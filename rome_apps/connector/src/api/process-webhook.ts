import type { Logger } from "@rome-os/app-runtime";
import { EventsRepo, MAX_PUBLISH_ATTEMPTS, publishRetryDelayMs } from "./events-repo.js";
import { normalizeGithubPayload } from "./github-webhook.js";
import {
  extractEventType,
  extractTriggerSlug,
  normalizeComposioPayload,
  type SubscriptionEvent,
} from "./normalize.js";
import { buildTopic } from "./topic.js";

const TRIGGER_MESSAGE_TYPE = "composio.trigger.message";

export type ProcessResult =
  | {
      kind: "ignored";
      reason: "not_a_trigger_message" | "missing_trigger_slug" | "unknown_trigger_slug";
    }
  | { kind: "emitted"; event: SubscriptionEvent; topic: string }
  | { kind: "deduped"; event: SubscriptionEvent; topic: string };

/** The system `publish_event` action — the producer surface that drops an
 * event onto Rome's central in-memory bus. Routines with a matching
 * `event-bus` trigger fire from there. */
const PUBLISH_EVENT_ACTION = "publish_event";

/** Bus-event `source`, matched against a routine's optional `sourcePattern`. */
const EVENT_SOURCE = "connector";

export type RunAction = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** An owed event older than this is abandoned rather than published, since a
 * routine fired for a day-old webhook (a stale PR review) does more harm than
 * good. */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60_000;

/**
 * Drains the outbox: publishes each stored event that is owed a publish and
 * due for an attempt onto Rome's central bus through the system
 * `publish_event` action, oldest first, so routines with a matching
 * `event-bus` trigger fire. The bus event's `name` is the event's topic, the
 * same string `POST /feeds` returned to the feed creator.
 *
 * A failed publish backs off (publishRetryDelayMs) and ends the drain. After
 * MAX_PUBLISH_ATTEMPTS failures, or past MAX_EVENT_AGE_MS, an event is
 * abandoned with an error log. Delivery is at-least-once: a process that dies
 * between publishing and recording it publishes the event again once its
 * claim lapses. Safe to run concurrently. A deduped webhook retry never
 * republishes, because the stored row is already published or claimed.
 */
export async function publishPendingEvents(
  repo: EventsRepo,
  runAction: RunAction,
  log: Logger,
  now: () => Date = () => new Date(),
): Promise<void> {
  for (;;) {
    const claimedAt = now();
    const event = await repo.claimNextUnpublished(claimedAt);
    if (!event) return;
    const fields = { eventId: event.eventId, topic: event.topic, provider: event.provider };
    if (claimedAt.getTime() - event.receivedAt.getTime() > MAX_EVENT_AGE_MS) {
      await repo.abandon(event.eventId);
      log.error("gave up publishing event to bus", { ...fields, reason: "expired" });
      continue;
    }
    try {
      await runAction(PUBLISH_EVENT_ACTION, {
        name: event.topic,
        source: EVENT_SOURCE,
        payload: JSON.parse(event.payloadJson) as unknown,
      });
    } catch (err) {
      const failures = event.publishAttempts + 1;
      const error = err instanceof Error ? err.message : String(err);
      if (failures >= MAX_PUBLISH_ATTEMPTS) {
        await repo.abandon(event.eventId);
        log.error("gave up publishing event to bus", { ...fields, attempts: failures, error });
      } else {
        const retryAt = new Date(now().getTime() + publishRetryDelayMs(failures));
        await repo.recordFailedPublish(event.eventId, failures, retryAt);
        log.warn("event publish failed, will retry", {
          ...fields,
          attempts: failures,
          retryAt: retryAt.toISOString(),
          error,
        });
      }
      return;
    }
    await repo.markPublished(event.eventId, now());
    log.info("published event to bus", fields);
  }
}

/**
 * Resolves a trigger slug to its owning toolkit slug. Returns `null` when
 * Composio doesn't recognize the slug (treated as ignored). Transient errors
 * (network, 5xx) should throw — the webhook handler will surface a non-2xx
 * response so Composio retries.
 */
export type ResolveToolkitSlug = (triggerSlug: string) => Promise<string | null>;

/**
 * Runs AFTER HMAC verification. Composio is the source of truth for
 * subscription state, so this routine does not consult any local feeds
 * table — it derives `(provider, eventType, topic)` from the verified V3
 * payload plus an authoritative toolkit lookup via `resolveToolkit` (typically
 * `ComposioClient.getTriggerType`). We only emit when
 * `type === composio.trigger.message` (lifecycle events like
 * `composio.trigger.disabled` also carry `metadata.trigger_slug` but are not
 * real fires).
 */
export async function processVerifiedWebhook(
  repo: EventsRepo,
  resolveToolkit: ResolveToolkitSlug,
  rawPayload: unknown,
  webhookId: string,
  receivedAt: Date,
): Promise<ProcessResult> {
  if (extractEventType(rawPayload) !== TRIGGER_MESSAGE_TYPE) {
    return { kind: "ignored", reason: "not_a_trigger_message" };
  }
  const triggerSlug = extractTriggerSlug(rawPayload);
  if (!triggerSlug) return { kind: "ignored", reason: "missing_trigger_slug" };

  const toolkit = await resolveToolkit(triggerSlug);
  if (!toolkit) return { kind: "ignored", reason: "unknown_trigger_slug" };

  const provider = toolkit.toLowerCase();
  const eventType = triggerSlug.toLowerCase();
  const topic = buildTopic(provider, eventType);

  const event = normalizeComposioPayload(
    rawPayload,
    { provider, eventType },
    webhookId,
    receivedAt.toISOString(),
  );

  const inserted = await repo.insertEventIfAbsent({
    eventId: event.eventId,
    topic,
    provider,
    eventType,
    receivedAt,
    payloadJson: JSON.stringify(event.data),
  });

  if (inserted) {
    await repo.pruneRingBuffer();
    return { kind: "emitted", event, topic };
  }
  return { kind: "deduped", event, topic };
}

/**
 * Runs AFTER GitHub HMAC verification — the GitHub twin of
 * `processVerifiedWebhook`, with no Composio involvement. The provider is always
 * `github` and the event type comes from the trusted `X-GitHub-Event` header, so
 * there is no trigger-slug → toolkit lookup: the topic is `github.<event>`
 * directly. `deliveryId` is GitHub's `X-GitHub-Delivery` GUID, which dedups
 * redeliveries (a manual redelivery or a relay replay reuses it) exactly like
 * the Composio webhook id.
 */
export async function processGithubWebhook(
  repo: EventsRepo,
  rawPayload: unknown,
  eventType: string,
  deliveryId: string,
  receivedAt: Date,
): Promise<ProcessResult> {
  const provider = "github";
  const normalizedEventType = eventType.toLowerCase();
  const topic = buildTopic(provider, normalizedEventType);

  const event = normalizeGithubPayload(
    rawPayload,
    normalizedEventType,
    deliveryId,
    receivedAt.toISOString(),
  );

  const inserted = await repo.insertEventIfAbsent({
    eventId: event.eventId,
    topic,
    provider,
    eventType: normalizedEventType,
    receivedAt,
    payloadJson: JSON.stringify(event.data),
  });

  if (inserted) {
    await repo.pruneRingBuffer();
    return { kind: "emitted", event, topic };
  }
  return { kind: "deduped", event, topic };
}
