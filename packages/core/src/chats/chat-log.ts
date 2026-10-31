// The one read of what was said in a place, over Chats' own tables
// (`chats`, `chat_messages`). Vocabulary: docs/domains/chats.md#message.
//
// The dashboard, an agent's wake and the history tool's fallback all read a
// place's messages this one way. `MessageRepository.recent` and `before` read
// today's rows and move onto this read when the writers do.

import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { MessageCursor } from "./message-repository.js";
import type { Place } from "./place.js";

/** A message as Chats holds it. `senderAgent` is set on exactly the lines one
 *  of Rome's agents said. `parts` is the message as composed, as JSON. */
export interface LoggedMessage {
  readonly id: string;
  readonly senderAccountId: string | null;
  readonly senderAgent: string | null;
  readonly senderName: string | null;
  readonly text: string;
  readonly parts: string;
  readonly platformMessageId: string | null;
  readonly replyTo: string | null;
  readonly at: Date;
}

/** Some of a place's messages, oldest first, and where the messages before
 *  them begin, or null when none are older. */
export interface LogPage {
  readonly messages: readonly LoggedMessage[];
  readonly older: MessageCursor | null;
}

export class ChatLog {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * The newest `limit` messages said in `place` before `before`, oldest first.
   * Without `before` the newest of all; without `limit` every one. A place
   * Rome holds no chat for answers an empty page.
   */
  async read(
    place: Place,
    page: { before?: MessageCursor | null; limit?: number } = {},
  ): Promise<LogPage> {
    const { before, limit } = page;
    // One more than asked says whether any are older.
    const rows = await this.db.all<MessageRow>(sql`
      SELECT m.id, m.sender_account_id, m.sender_agent, m.sender_name, m.text, m.parts,
             m.platform_message_id, m.reply_to_platform_message_id, m.said_at
      FROM chats c
      JOIN chat_messages m ON m.chat_id = c.id AND m.thread_id IS ${place.threadId ?? null}
      WHERE c.platform = ${place.chat.platform} AND c.platform_chat_id = ${place.chat.id}
        ${
          before
            ? sql`AND (m.said_at, m.rowid) < (${seconds(before.at)},
                (SELECT rowid FROM chat_messages WHERE id = ${before.id}))`
            : sql``
        }
      -- Within a second, the order they were recorded in.
      ORDER BY m.said_at DESC, m.rowid DESC
      ${limit === undefined ? sql`` : sql`LIMIT ${limit + 1}`}
    `);
    const shown = limit === undefined ? rows : rows.slice(0, limit);
    const oldest = shown.at(-1);
    return {
      messages: shown.reverse().map(toMessage),
      older:
        limit !== undefined && rows.length > limit && oldest
          ? { at: new Date(oldest.said_at * 1000), id: oldest.id }
          : null,
    };
  }
}

interface MessageRow {
  id: string;
  sender_account_id: string | null;
  sender_agent: string | null;
  sender_name: string | null;
  text: string;
  parts: string;
  platform_message_id: string | null;
  reply_to_platform_message_id: string | null;
  said_at: number;
}

function toMessage(row: MessageRow): LoggedMessage {
  return {
    id: row.id,
    senderAccountId: row.sender_account_id,
    senderAgent: row.sender_agent,
    senderName: row.sender_name,
    text: row.text,
    parts: row.parts,
    platformMessageId: row.platform_message_id,
    replyTo: row.reply_to_platform_message_id,
    at: new Date(row.said_at * 1000),
  };
}

function seconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}
