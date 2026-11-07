import { z } from "zod";
// Wire contract of the dashboard live-events WebSocket at `/ws/events`. The
// server is packages/core/src/live-events-server.ts and the client is
// packages/web/src/lib/live-events.ts. Frames are JSON text.

export const CHAT_STATUS_TOPIC = "chat.status";
/** The Concierge task panel's rows. Its only event is `task_upsert`. */
export const CONCIERGE_TASKS_TOPIC = "concierge.tasks";
export const APP_CATALOG_TOPIC = "apps.catalog";
export const CHAT_SESSION_TOPIC_PREFIX = "chat.session:";

/**
 * The upgrade header the phone app sends, with {@link PHONE_CLIENT} as its
 * value. A chat the guardian's phone holds open this way gets no push for
 * what the Concierge says there. Browsers cannot set it on a WebSocket.
 */
export const LIVE_EVENTS_CLIENT_HEADER = "x-rome-client";
export const PHONE_CLIENT = "phone";

/** The topic carrying one chat session's events. */
export function chatSessionTopicName(sessionId: string): string {
  return `${CHAT_SESSION_TOPIC_PREFIX}${sessionId}`;
}

/** Client to server. Subscribing to a topic the socket already holds is a no-op. */
export const liveEventsClientMessageSchema = z.object({
  type: z.enum(["subscribe", "unsubscribe"]),
  topic: z.string().max(256),
});
export type LiveEventsClientMessage = z.infer<typeof liveEventsClientMessageSchema>;

/**
 * Server to client. `subscribed` precedes every event of that subscription.
 * An `error` with a topic means that subscription is gone, and one without a
 * topic answers a frame the server could not read.
 */
export const liveEventsServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribed"), topic: z.string() }),
  z.object({
    type: z.literal("event"),
    topic: z.string(),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({ type: z.literal("error"), topic: z.string().optional(), message: z.string() }),
]);
export type LiveEventsServerMessage = z.infer<typeof liveEventsServerMessageSchema>;
