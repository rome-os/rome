// Messages on record, over `chat_messages`. Vocabulary:
// docs/domains/chats.md#message.
//
// Three operations: record what reached Rome, send what Rome says, and read a
// place newest first. Nothing here knows about turns or sessions: Agents
// links a message to a turn after one of these returns its id.

import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { chatMessages, chats } from "../../db/schema/system.js";
import { createLogger } from "../../logger.js";
import {
  partsText,
  plainText,
  type Message,
  type OutboundMessage,
  type RecordedMessage,
  type SaidBy,
  type SaidMessage,
} from "./message.js";
import type { ChatId } from "@rome-os/app-runtime";
import { placeIn, type ChatRef, type Place } from "./place.js";

const log = createLogger("chat-messages");

/** A position in a place's messages: the message a page ended at. Opaque to
 *  callers, which hand back the one a page answered. */
export interface MessageCursor {
  readonly at: Date;
  readonly id: number;
}

/** Some of a place's messages, oldest first, and where the messages before
 *  them begin, or null when none are older. */
export interface MessagePage {
  readonly messages: readonly SaidMessage[];
  readonly older: MessageCursor | null;
  /** Where the next page of an `after` read starts, or null at the newest. */
  readonly newer: MessageCursor | null;
}

/** Where a send goes, by its adapter's keys: the chat's, and the quoted
 *  line's when the send quotes one. */
export interface SendTarget {
  readonly chat: string;
  readonly replyTo?: string;
}

/**
 * Delivers a message to its platform at `target` and answers the key the
 * adapter gives it, and the thread it landed in when the platform placed it
 * in another than the one it was sent to (null for the open chat). Throws
 * when the platform refused it. On the dashboard, where Rome is the
 * platform, the dashboard adapter mints the key.
 */
export type Deliver = (
  target: SendTarget,
) => Promise<{ key: string; landedIn?: { threadId: ChatId | null } }>;

/** A sent message: its adapter's key, and the id Rome recorded it under, or
 *  null when the platform took it but the record did not land. */
export interface Sent {
  readonly id: number | null;
  readonly key: string;
  readonly recorded: boolean;
  readonly at: Date;
}

export class MessageRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Put `message` on record in its place, and answer it with its id, or null
   * when its key is already on record in that chat: recording again changes
   * nothing. A quote of a line Rome does not hold quotes nothing. The place's
   * chat must already exist: a message never starts its chat. Throws when it
   * does not.
   */
  record(message: Message): RecordedMessage | null {
    const chatId = this.chatOf(message.place).id;
    const inserted = this.db
      .insert(chatMessages)
      .values({
        chatId,
        key: message.key,
        threadId: message.place.threadId ?? null,
        senderAccountId: message.saidBy.account.id,
        senderAgent: message.saidBy.agent ?? null,
        senderName: message.saidBy.name ?? null,
        text: plainText(message.body),
        parts: JSON.stringify(
          message.parts ?? [{ type: "text", content: plainText(message.body) }],
        ),
        replyToMessageId: message.replyTo === undefined ? null : this.idIn(chatId, message.replyTo),
        saidAt: message.at,
      })
      .onConflictDoNothing()
      .returning({ id: chatMessages.id, replyTo: chatMessages.replyToMessageId })
      .all();
    const row = inserted[0];
    if (!row) return null;
    const { replyTo: _quoted, ...rest } = message;
    return { ...rest, id: row.id, ...(row.replyTo === null ? {} : { replyTo: row.replyTo }) };
  }

  /**
   * Deliver `message` and put it on record once the platform took it. A
   * delivery that throws records nothing and the error reaches the caller.
   * Once the platform took the message, a failure to record it is logged and
   * the send still answers, with no id: reporting a sent message as failed
   * invites a second real one. It is recorded in the thread the platform
   * placed it in. The place's chat must already exist.
   */
  async send(message: OutboundMessage, deliver: Deliver): Promise<Sent> {
    if (!message.saidBy.agent) {
      throw new Error("A message Rome sends needs the agent that said it");
    }
    // Only the account's id is kept; its platform is the chat's.
    if (message.saidBy.account.platform !== message.place.chat.platform) {
      throw new Error(
        `A message in a ${message.place.chat.platform} chat cannot be said by a ${message.saidBy.account.platform} account`,
      );
    }
    const chat = this.chatOf(message.place);
    // A quote names a line in the same chat: a key is unique only there.
    const quoted =
      message.replyTo === undefined
        ? null
        : typeof message.replyTo === "number"
          ? this.keyIn(chat.id, message.replyTo)
          : message.replyTo.key;
    const { key, landedIn } = await deliver({
      chat: chat.key,
      ...(quoted ? { replyTo: quoted } : {}),
    });
    // The line is on record where the platform put it.
    const threadId = landedIn ? landedIn.threadId : (message.place.threadId ?? null);
    const at = new Date();
    try {
      // The platform answered a key already on record: the same message.
      this.db
        .insert(chatMessages)
        .values({
          chatId: chat.id,
          key,
          threadId,
          senderAccountId: message.saidBy.account.id,
          senderAgent: message.saidBy.agent ?? null,
          senderName: message.saidBy.name ?? null,
          text: partsText(message.parts),
          parts: JSON.stringify(message.parts),
          // A quote by key links once Rome holds that line, which it may by
          // now even when it did not before the send.
          replyToMessageId:
            quoted === null
              ? null
              : typeof message.replyTo === "number"
                ? message.replyTo
                : this.idIn(chat.id, quoted),
          saidAt: at,
        })
        .onConflictDoNothing()
        .run();
      return { id: this.idIn(chat.id, key), key, recorded: true, at };
    } catch (error) {
      log.warn("message delivered but recording failed", {
        chatId: chat.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { id: null, key, recorded: false, at };
    }
  }

  /**
   * A page of the messages said in `place`, oldest first, bounded one of two
   * ways. With `before`, or no bound, the newest `limit` said before it, and
   * a cursor to the older ones. With `after`, the first `limit` said after
   * it, and a cursor to the newer ones: a cursor names the last message
   * read, and a bare time leaves out every message said in that second or
   * before. Without `limit` every one. A place Rome holds no chat for answers
   * an empty page. Lines said in one second keep the order they were
   * recorded in.
   */
  read(
    place: Place,
    page: {
      before?: MessageCursor | null;
      after?: MessageCursor | { readonly at: Date };
      limit?: number;
    } = {},
  ): MessagePage {
    const { before, after, limit } = page;
    if (after) return this.readAfter(place, after, limit);
    // One more than asked says whether any are older.
    const rows = this.db.all<MessageRow>(sql`
      SELECT ${MESSAGE_COLUMNS}
      FROM chat_messages m
      WHERE m.chat_id = ${chatIdOf(place.chat)} AND m.thread_id IS ${place.threadId ?? null}
        ${before ? sql`AND (m.said_at, m.id) < (${seconds(before.at)}, ${before.id})` : sql``}
      ORDER BY m.said_at DESC, m.id DESC
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
      newer: null,
    };
  }

  private readAfter(
    place: Place,
    after: MessageCursor | { readonly at: Date },
    limit: number | undefined,
  ): MessagePage {
    const bound =
      "id" in after
        ? sql`(m.said_at, m.id) > (${seconds(after.at)}, ${after.id})`
        : sql`m.said_at > ${seconds(after.at)}`;
    // One more than asked says whether any are newer.
    const rows = this.db.all<MessageRow>(sql`
      SELECT ${MESSAGE_COLUMNS}
      FROM chat_messages m
      WHERE m.chat_id = ${chatIdOf(place.chat)} AND m.thread_id IS ${place.threadId ?? null} AND ${bound}
      ORDER BY m.said_at, m.id
      ${limit === undefined ? sql`` : sql`LIMIT ${limit + 1}`}
    `);
    const shown = limit === undefined ? rows : rows.slice(0, limit);
    const newest = shown.at(-1);
    return {
      messages: shown.map((row) => said(place, row)),
      older: null,
      newer:
        limit !== undefined && rows.length > limit && newest
          ? { at: new Date(newest.said_at * 1000), id: newest.id }
          : null,
    };
  }

  /** The messages `ids` name that are on record, wherever they were said, in
   *  the order they were said. */
  byIds(ids: readonly number[]): SaidMessage[] {
    if (ids.length === 0) return [];
    return this.db
      .all<MessageRow & PlaceRow>(sql`
        SELECT ${MESSAGE_COLUMNS}, c.platform, m.chat_id, m.thread_id
        FROM chat_messages m JOIN chats c ON c.id = m.chat_id
        WHERE m.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        ORDER BY m.said_at, m.id
      `)
      .map((row) => said(placeOf(row), row));
  }

  /** The parts of a line its adapter keys `key`, in whichever chat: the
   *  oldest such line. A dashboard line's key is unique on its own. */
  partsKeyed(key: string): string | null {
    return (
      this.db.all<{ parts: string }>(sql`
        SELECT parts FROM chat_messages WHERE key = ${key} ORDER BY id LIMIT 1
      `)[0]?.parts ?? null
    );
  }

  /** The id of the line its adapter keys `key` in `chat`, or null when Rome
   *  holds none. */
  idOf(chat: ChatRef, key: string): number | null {
    return (
      this.db.all<{ id: number }>(sql`
        SELECT id FROM chat_messages WHERE chat_id = ${chatIdOf(chat)} AND key = ${key}
      `)[0]?.id ?? null
    );
  }

  /** The chat on `platform` that holds a line its adapter keys `key`, the
   *  oldest such line's, or null when Rome holds none. For platforms whose
   *  keys are unique across chats, as an email's message id is. */
  chatHolding(platform: string, key: string): ChatRef | null {
    const row = this.db.all<{ id: number }>(sql`
      SELECT c.id FROM chat_messages m JOIN chats c ON c.id = m.chat_id
      WHERE c.platform = ${platform} AND m.key = ${key}
      ORDER BY m.id LIMIT 1
    `)[0];
    return row ? { platform, id: row.id } : null;
  }

  private idIn(chatId: number, key: string): number | null {
    return (
      this.db.all<{ id: number }>(sql`
        SELECT id FROM chat_messages WHERE chat_id = ${chatId} AND key = ${key}
      `)[0]?.id ?? null
    );
  }

  /** The adapter's key for message `id` in chat `chatId`, or null when Rome
   *  holds none there. */
  private keyIn(chatId: number, id: number): string | null {
    return (
      this.db.all<{ key: string }>(
        sql`SELECT key FROM chat_messages WHERE id = ${id} AND chat_id = ${chatId}`,
      )[0]?.key ?? null
    );
  }

  /** The adapter's key for message `id`, or null when Rome holds none. */
  keyOf(id: number): string | null {
    return (
      this.db.all<{ key: string }>(sql`SELECT key FROM chat_messages WHERE id = ${id}`)[0]?.key ??
      null
    );
  }

  /** The chat `place` is in, which must already exist: a message never
   *  starts its chat. */
  private chatOf(place: Place): { id: number; key: string } {
    const row = this.db.all<{ id: number; key: string }>(sql`
      SELECT id, key FROM ${chats} WHERE id = ${place.chat.id} AND platform = ${place.chat.platform}
    `)[0];
    if (!row) {
      throw new Error(`No chat at ${place.chat.platform}:${place.chat.id} to record a message in`);
    }
    return row;
  }
}

/** The id `ref` names, when Rome holds that chat on `ref`'s platform: a
 *  ref on another platform names no chat. */
function chatIdOf(ref: ChatRef) {
  return sql`(SELECT id FROM chats WHERE id = ${ref.id} AND platform = ${ref.platform})`;
}

const MESSAGE_COLUMNS = sql.raw(`m.id, m.key, m.sender_account_id, m.sender_agent, m.sender_name,
  m.text, m.parts, m.reply_to_message_id, m.said_at`);

interface MessageRow {
  id: number;
  key: string;
  sender_account_id: string | null;
  sender_agent: string | null;
  sender_name: string | null;
  text: string;
  parts: string;
  reply_to_message_id: number | null;
  said_at: number;
}

interface PlaceRow {
  platform: string;
  chat_id: number;
  thread_id: string | null;
}

function placeOf(row: PlaceRow): Place {
  return placeIn(
    { platform: row.platform, id: row.chat_id },
    (row.thread_id ?? undefined) as ChatId | undefined,
  );
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
    key: row.key,
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
