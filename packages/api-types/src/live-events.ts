import { z } from "zod";
// Wire contract of the dashboard live-events WebSocket at `/ws/events`. The
// server is packages/core/src/live-events-server.ts and the client is
// packages/web/src/lib/live-events.ts. Frames are JSON text.

export const CHAT_STATUS_TOPIC = "chat.status";
export const APP_CATALOG_TOPIC = "apps.catalog";
export const CHAT_SESSION_TOPIC_PREFIX = "chat.session:";
export const FILE_WATCH_TOPIC_PREFIX = "files.watch:";

/** The topic carrying one chat session's events. */
export function chatSessionTopicName(sessionId: string): string {
  return `${CHAT_SESSION_TOPIC_PREFIX}${sessionId}`;
}

export const FILE_WATCH_SCOPES = ["projects", "memory"] as const;
export type FileWatchScope = (typeof FILE_WATCH_SCOPES)[number];

/**
 * The topic carrying one file watch. `key` stands for the watched path set,
 * which travels in the subscribe frame's `params` because it outgrows the
 * topic. Listeners share a subscription only when they watch the same set, so
 * changing the set is an unsubscribe and a subscribe to a new topic.
 */
export function fileWatchTopicName(scope: FileWatchScope, key: string): string {
  return `${FILE_WATCH_TOPIC_PREFIX}${scope}:${key}`;
}

export const MAX_FILE_WATCH_PATHS = 256;
export const MAX_FILE_WATCH_PATH_LENGTH = 1024;
/**
 * The UTF-8 size of the largest `params` a client may send. The server reads
 * frames up to this size plus room for the rest of the frame.
 */
export const MAX_SUBSCRIBE_PARAMS_BYTES = 32 * 1024;

/** A `files.watch` subscription's `params`: the logical directories to watch. */
export const fileWatchParamsSchema = z.object({
  watch: z.array(z.string().max(MAX_FILE_WATCH_PATH_LENGTH)).max(MAX_FILE_WATCH_PATHS),
});
export type FileWatchParams = z.infer<typeof fileWatchParamsSchema>;

/**
 * Client to server. Subscribing to a topic the socket already holds is a
 * no-op. `params` is read only by topics that take it, and each of those
 * validates it.
 */
export const liveEventsClientMessageSchema = z.object({
  type: z.enum(["subscribe", "unsubscribe"]),
  topic: z.string().max(256),
  params: z.unknown().optional(),
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
