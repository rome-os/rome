// Messages on record, over `chat_messages`. Vocabulary:
// docs/domains/chats.md#message.
//
// Three operations: record what reached Rome, send what Rome says, and read a
// place newest first. Nothing here knows about turns or sessions: Agents
// links a message to a turn after one of these returns its id.

import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DrizzleDb } from "../db/index.js";
import { chatMessages, chats } from "../db/schema/system.js";
import { createLogger } from "../logger.js";
import {
  partsText,
  plainText,
  type Message,
  type OutboundMessage,
  type RecordedMessage,
  type SaidBy,
  type SaidMessage,
} from "./message.js";
import type { Place } from "./place.js";

const log = createLogger("chat-messages");

/** A position in a place's messages: the message a page ended at. Opaque to
 *  callers, which hand back the one a page answered. */
export interface MessageCursor {
  readonly at: Date;
  readonly id: string;
}

/** Some of a place's messages, oldest first, and where the messages before
 *  them begin, or null when none are older. */
export interface MessagePage {
  readonly messages: readonly SaidMessage[];
  readonly older: MessageCursor | null;
}

/**
 * Delivers a message to its platform and answers its adapter's id for it,
 * unique in its chat. Throws when the platform refused it. On the dashboard,
 * where Rome is the platform, it answers at once with no id, and the
 * dashboard's own id for the message stands.
 */
export type Deliver = () => Promise<{ id?: string }>;

/** A sent message: its adapter's id, and whether Rome recorded it, which it
 *  failed to when the platform took it but the record did not land. */
export interface Sent {
  readonly id: string;
  readonly recorded: boolean;
  readonly at: Date;
}

export class MessageRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Put `message` on record in its place, and answer it, or null when its id
   * is already on record in that chat: recording again changes nothing. The place's chat must already exist: a
   * message never starts its chat. Throws when it does not.
   */
  async record(message: Message): Promise<RecordedMessage | null> {
    const chatId = this.chatIdOf(message.place);
    const id = message.id;
    const inserted = this.db
      .insert(chatMessages)
      .values({
        id,
        chatId,
        threadId: message.place.threadId ?? null,
        senderAccountId: message.saidBy.account.id,
        senderAgent: message.saidBy.agent ?? null,
        senderName: message.saidBy.name ?? null,
        text: plainText(message.body),
        parts: JSON.stringify(
          message.parts ?? [{ type: "text", content: plainText(message.body) }],
        ),
        replyToMessageId: message.replyTo ?? null,
        saidAt: message.at,
      })
      .onConflictDoNothing()
      .returning({ id: chatMessages.id })
      .all();
    return inserted.length === 0 ? null : message;
  }

  /**
   * Deliver `message` and put it on record once the platform took it. A
   * delivery that throws records nothing and the error reaches the caller.
   * Once the platform took the message, a failure to record it is logged and
   * the send still answers, with no id: reporting a sent message as failed
   * invites a second real one. The place's chat must already exist.
   */
  async send(message: OutboundMessage, deliver: Deliver): Promise<Sent> {
    const chatId = this.chatIdOf(message.place);
    const delivered = await deliver();
    const id = delivered.id ?? message.id ?? uuidv7();
    const at = new Date();
    try {
      this.db
        .insert(chatMessages)
        .values({
          id,
          chatId,
          threadId: message.place.threadId ?? null,
          senderAccountId: message.saidBy.account.id,
          senderAgent: message.saidBy.agent ?? null,
          senderName: message.saidBy.name ?? null,
          text: partsText(message.parts),
          parts: JSON.stringify(message.parts),
          replyToMessageId: message.replyTo ?? null,
          saidAt: at,
        })
        // The platform answered an id already on record: the same message.
        .onConflictDoNothing()
        .run();
      return { id, recorded: true, at };
    } catch (error) {
      log.warn("message delivered but recording failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { id, recorded: false, at };
    }
  }

  /**
   * The newest `limit` messages said in `place` before `before`, oldest
   * first. Without `before` the newest of all; without `limit` every one. A
   * place Rome holds no chat for answers an empty page.
   */
  async read(
    place: Place,
    page: { before?: MessageCursor | null; limit?: number } = {},
  ): Promise<MessagePage> {
    const { before, limit } = page;
    // One more than asked says whether any are older.
    const rows = this.db.all<MessageRow>(sql`
      SELECT m.id, m.sender_account_id, m.sender_agent, m.sender_name, m.text, m.parts,
             m.reply_to_message_id, m.said_at
      FROM chat_messages m
      WHERE m.chat_id = ${place.chat.id} AND m.thread_id IS ${place.threadId ?? null}
        ${before ? sql`AND (m.said_at, m.rowid) < (${seconds(before.at)}, (SELECT rowid FROM chat_messages WHERE id = ${before.id}))` : sql``}
      ORDER BY m.said_at DESC, m.rowid DESC
      ${limit === undefined ? sql`` : sql`LIMIT ${limit + 1}`}
    `);
    const shown = limit === undefined ? rows : rows.slice(0, limit);
    const oldest = shown.at(-1);
    return {
      messages: shown.reverse().map((row) => said(place, row)),
      older:
        limit !== undefined && rows.length > limit && oldest
          ? { at: new Date(oldest.said_at * 1000), id: oldest.id }
          : null,
    };
  }

  /** The chat `place` is in, which must already exist: a message never
   *  starts its chat. */
  private chatIdOf(place: Place): string {
    const row = this.db.all<{ id: string }>(sql`
      SELECT id FROM ${chats} WHERE id = ${place.chat.id}
    `)[0];
    if (!row) {
      throw new Error(`No chat at ${place.chat.platform}:${place.chat.id} to record a message in`);
    }
    return row.id;
  }
}

interface MessageRow {
  id: string;
  sender_account_id: string | null;
  sender_agent: string | null;
  sender_name: string | null;
  text: string;
  parts: string;
  reply_to_message_id: string | null;
  said_at: number;
}

function said(place: Place, row: MessageRow): SaidMessage {
  const saidBy: SaidBy | undefined =
    row.sender_account_id === null
      ? undefined
      : {
          account: { platform: place.chat.platform, id: row.sender_account_id },
          ...(row.sender_name === null ? {} : { name: row.sender_name }),
          ...(row.sender_agent === null ? {} : { agent: row.sender_agent }),
        };
  return {
    id: row.id,
    direction: row.sender_agent === null ? "toRome" : "fromRome",
    place,
    ...(saidBy ? { saidBy } : {}),
    ...(row.sender_name === null ? {} : { senderName: row.sender_name }),
    body: { text: row.text },
    parts: row.parts,
    ...(row.reply_to_message_id === null ? {} : { replyTo: row.reply_to_message_id }),
    at: new Date(row.said_at * 1000),
  };
}

function seconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}
