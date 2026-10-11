// What kind of session a `rome_sessions` row is, as its readers see it.
//
// A guardian chat is a channel row on the webchat channel: `type = 'channel'`
// with `source_channel = 'webchat'`. The API still reports it as `webchat`, so
// readers go through these helpers rather than reading `type` directly.

import { and, eq, sql, type SQL } from "drizzle-orm";
import { romeSessions, webchatChatWhere } from "./schema.js";

/**
 * The id of the conversation at a channel address. A webchat thread id is the
 * chat's own id, so its conversation is the chat itself.
 */
export function channelConversationId(channel: string, threadId: string): string {
  return channel === "webchat" ? threadId : `channel:${channel}:${threadId}`;
}

/**
 * Whether a row is a guardian chat. Every chat writer also sets
 * `source_thread_id = id`, and the Dream and Showcases raw SQL matches chats on
 * that, so a writer that breaks it hides the chat from those apps only.
 */
export const isWebchatChat: SQL = webchatChatWhere(romeSessions);

/** Whether a row is a conversation on a messaging channel, chats excluded. */
export const isChannelConversation: SQL = and(
  eq(romeSessions.type, "channel"),
  sql`coalesce(${romeSessions.sourceChannel}, '') <> 'webchat'`,
) as SQL;

/** The row's type, with a chat reading as `webchat`. */
export const romeSessionKind = sql<string>`case when ${isWebchatChat} then 'webchat' else ${romeSessions.type} end`;

type SessionKindFields = {
  type: string;
  sourceChannel?: string | null;
};

/** {@link romeSessionKind} for a row already in memory. */
export function sessionKindOf(row: SessionKindFields): string {
  return row.type === "channel" && row.sourceChannel === "webchat" ? "webchat" : row.type;
}

/** The `type` stored for a session of this kind. A chat is a channel row. */
export function storedSessionType<T extends string>(kind: T): Exclude<T, "webchat"> | "channel" {
  return kind === "webchat" ? "channel" : (kind as Exclude<T, "webchat">);
}

/** The row with its `type` read through {@link sessionKindOf}. */
export function withSessionKind<T extends SessionKindFields>(row: T): T {
  const type = sessionKindOf(row);
  return type === row.type ? row : { ...row, type };
}
