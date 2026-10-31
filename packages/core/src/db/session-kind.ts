// What kind of session a `rome_sessions` row is, as its readers see it.
//
// A guardian chat is a channel row whose chat is on the dashboard: `type =
// 'channel'` with its `chat_id` on the webchat platform. The API still reports
// it as `webchat`, so readers go through these helpers rather than reading
// `type` directly.

import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { chatIdsOn } from "../chats/chat-repository.js";
import { romeSessions } from "./schema.js";

const dashboardChats = chatIdsOn("webchat");

/**
 * The id of the conversation at a channel address. A webchat thread id is the
 * chat's own id, so its conversation is the chat itself.
 */
export function channelChatId(channel: string, threadId: string): string {
  return channel === "webchat" ? threadId : `channel:${channel}:${threadId}`;
}

/** Whether a row is a guardian chat: a channel row whose chat is on the
 *  dashboard. */
export const isWebchatChat: SQL = sql`(${romeSessions.type} = 'channel' and ${romeSessions.chatId} in ${dashboardChats})`;

/** Whether a row is a conversation on a messaging channel, chats excluded. */
export const isChannelConversation: SQL = and(
  eq(romeSessions.type, "channel"),
  sql`(${romeSessions.chatId} is null or ${romeSessions.chatId} not in ${dashboardChats})`,
) as SQL;

/** Every column of a `rome_sessions` row a reader reads, and whether it is a guardian chat,
 *  which {@link withSessionKind} reads. */
const { sourceChannel: _unread, ...sessionColumns } = getTableColumns(romeSessions);

/** Every column of a `rome_sessions` row a reader reads. `source_channel` is
 *  written by no one and read by no one until the contract step drops it. */
export { sessionColumns };

export const sessionRowWithKind = {
  ...sessionColumns,
  onDashboard: sql<boolean>`${isWebchatChat}`.mapWith(Boolean),
};

/** The row's type, with a chat reading as `webchat`. */
export const romeSessionKind = sql<string>`case when ${isWebchatChat} then 'webchat' else ${romeSessions.type} end`;

type SessionKindFields = {
  type: string;
  /** Whether the row is a guardian chat, as {@link sessionRowWithKind}
   *  reads it. */
  onDashboard?: boolean;
};

/** {@link romeSessionKind} for a row already in memory. */
export function sessionKindOf(row: SessionKindFields): string {
  return row.type === "channel" && row.onDashboard === true ? "webchat" : row.type;
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
