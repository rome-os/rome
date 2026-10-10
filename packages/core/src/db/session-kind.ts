// What kind of session a `rome_sessions` row is, as its readers see it.
//
// A guardian chat is stored today as `type = 'webchat'`. It is moving to an
// ordinary channel row, `type = 'channel'` with `source_channel = 'webchat'`.
// Readers go through these helpers so that both forms read as the same chat,
// and the stored value can change without them.
//
// A chat's address is its own id, which is what separates it from a row that
// merely names a webchat thread: forks and subagent runs copy their parent's
// address under their own id, and older outbound sends left
// `channel:webchat:<id>` rows that name a chat without being one.

import { and, eq, sql, type SQL } from "drizzle-orm";
import { romeSessions } from "./schema.js";

/**
 * Whether a row is a guardian chat, in either stored form. The text matches the
 * WHERE of the partial chat indexes in `schema/system.ts`, so SQLite can page
 * the sidebar off them in order. That needs the constants inlined, not bound,
 * and the unary `+` on `type`, which stops SQLite from splitting the OR across
 * the `type` indexes and sorting the union instead.
 */
export const isWebchatChat: SQL = sql`(+${romeSessions.type} = 'webchat' or (+${romeSessions.type} = 'channel' and ${romeSessions.sourceChannel} = 'webchat' and ${romeSessions.sourceThreadId} = ${romeSessions.id}))`;

/** Whether a row is a conversation on a messaging channel, chats excluded. */
export const isChannelConversation: SQL = and(
  eq(romeSessions.type, "channel"),
  sql`coalesce(${romeSessions.sourceChannel}, '') <> 'webchat'`,
) as SQL;

/** The row's type, with a chat stored as a channel row reading as `webchat`. */
export const romeSessionKind = sql<string>`case when ${romeSessions.type} = 'channel' and ${romeSessions.sourceChannel} = 'webchat' and ${romeSessions.sourceThreadId} = ${romeSessions.id} then 'webchat' else ${romeSessions.type} end`;

type SessionKindFields = {
  id: string;
  type: string;
  sourceChannel?: string | null;
  sourceThreadId?: string | null;
};

/** {@link romeSessionKind} for a row already in memory. */
export function sessionKindOf(row: SessionKindFields): string {
  return row.type === "channel" && row.sourceChannel === "webchat" && row.sourceThreadId === row.id
    ? "webchat"
    : row.type;
}

/** The row with its `type` read through {@link sessionKindOf}. */
export function withSessionKind<T extends SessionKindFields>(row: T): T {
  const type = sessionKindOf(row);
  return type === row.type ? row : { ...row, type };
}
