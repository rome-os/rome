import { z } from "zod";
// Wire contract of the dashboard live-events WebSocket at `/ws/events`. The
// server is packages/core/src/live-events-server.ts and the client is
// packages/web/src/lib/live-events.ts. Frames are JSON text.

export const CHAT_STATUS_TOPIC = "chat.status";

/** The agent's display name changed. Carried on chat.status alongside running state. */
export const agentNameChangedSchema = z.object({ agentName: z.string() });
/** The Concierge task panel's rows. Its only event is `task_upsert`. */
export const CONCIERGE_TASKS_TOPIC = "concierge.tasks";
/**
 * What the caller's own Concierge chats are doing. Its only event is
 * `concierge_activity` (`ConciergeActivityEvent`): one for each of the
 * caller's Concierge chats on subscribe, then one whenever a chat's activity
 * changes.
 */
export const CONCIERGE_ACTIVITY_TOPIC = "concierge.activity";
export const APP_CATALOG_TOPIC = "apps.catalog";
export const CHAT_SESSION_TOPIC_PREFIX = "chat.session:";
/**
 * One of the caller's own Concierge chats' task list. Its only event is
 * `tasks_changed` (`TaskListChangedEvent`), whenever something the list holds
 * changes; another owner's chat is not found.
 */
export const CHAT_TASKS_TOPIC_PREFIX = "chat.tasks:";
/**
 * The chat the phone app has on screen, for the guardian or a visitor signed
 * in on it. It carries no events: the phone holds it for that one chat, and
 * the Concierge does not push what it says there to that person. Only a phone
 * socket's watch counts ({@link LIVE_EVENTS_CLIENT_HEADER}).
 */
export const CHAT_WATCH_TOPIC_PREFIX = "chat.watch:";

/**
 * The upgrade header the phone app sends, with {@link PHONE_CLIENT} as its
 * value. Only such a socket's `chat.watch:` subscription counts as the phone
 * showing that chat. Browsers cannot set it on a WebSocket.
 */
export const LIVE_EVENTS_CLIENT_HEADER = "x-rome-client";
export const PHONE_CLIENT = "phone";

/** The topic carrying one chat session's events. */
export function chatSessionTopicName(sessionId: string): string {
  return `${CHAT_SESSION_TOPIC_PREFIX}${sessionId}`;
}

/** The topic carrying one Concierge chat's task list changes. */
export function chatTasksTopicName(chatId: string): string {
  return `${CHAT_TASKS_TOPIC_PREFIX}${chatId}`;
}

/** The topic the phone holds for the chat on its screen. */
export function chatWatchTopicName(chatId: string): string {
  return `${CHAT_WATCH_TOPIC_PREFIX}${chatId}`;
}

/**
 * Client to server. Subscribing to a topic the socket already holds is a no-op.
 * `activity` says whether the person is at this dashboard: `active` after
 * input, `away` once the tab is hidden, loses focus or closes. While a
 * person's dashboard counts as active, the Concierge pushes nothing to that
 * person's phone. A phone socket's signals count for nothing. The server
 * answers none.
 */
export const liveEventsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), topic: z.string().max(256) }),
  z.object({ type: z.literal("unsubscribe"), topic: z.string().max(256) }),
  z.object({ type: z.literal("activity"), state: z.enum(["active", "away"]) }),
]);
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
