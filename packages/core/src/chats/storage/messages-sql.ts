// Chats' messages and chats as a read outside Chats joins them in SQL. Chats'
// tables stay its own: the read model reads these relations, whose columns
// are Chats' names for what a message and a chat hold, so a change to how Chats
// stores a message changes this file and not its readers. SQLite flattens
// each into the query that reads it, so a read keeps the tables' indexes.
// Vocabulary: docs/domains/chats.md.

import { sql } from "drizzle-orm";

/**
 * Every message said in a chat: its `id`, its adapter's `key`, its place (`chat_id`, `thread_id`),
 * who said it (`sender_account_id`, `sender_name`, and `sender_agent`, set
 * on exactly Rome's messages), what was said (`text`, and `parts` as JSON), the
 * message it quotes (`reply_to`), when (`said_at`, unix seconds), and `seq`,
 * the order Chats recorded it in, `chat_thread_id`, the chat thread it is in, and
 * `reaction`, the emoji it was reacted to with.
 */
export const CHAT_MESSAGES = sql.raw(`(SELECT id, key, chat_id, thread_id, sender_account_id,
  sender_name, sender_agent, text, parts, reply_to_message_id AS reply_to, said_at,
  id AS seq, chat_thread_id, reaction FROM chat_messages)`);

/** Every chat: its `id`, `platform`, its adapter's `key`, `kind` and `name`. */
export const CHATS = sql.raw(`(SELECT id, platform, key, kind, name FROM chats)`);
