// Chats' lines and chats as a read outside Chats joins them in SQL. Chats'
// tables stay its own: the read model reads these relations, whose columns
// are Chats' names for what a line and a chat hold, so a change to how Chats
// stores a message changes this file and not its readers. SQLite flattens
// each into the query that reads it, so a read keeps the tables' indexes.
// Vocabulary: docs/domains/chats.md.

import { sql } from "drizzle-orm";

/**
 * Every line said in a chat: its `id`, its adapter's `key`, its place (`chat_id`, `thread_id`),
 * who said it (`sender_account_id`, `sender_name`, and `sender_agent`, set
 * on exactly Rome's lines), what was said (`text`, and `parts` as JSON), the
 * line it quotes (`reply_to`), when (`said_at`, unix seconds), and `seq`,
 * the order Chats recorded it in.
 */
export const CHAT_LINES = sql.raw(`(SELECT id, key, chat_id, thread_id, sender_account_id,
  sender_name, sender_agent, text, parts, reply_to_message_id AS reply_to, said_at,
  id AS seq FROM chat_messages)`);

/** Every chat: its `id`, `platform`, its adapter's `key`, `kind` and `name`. */
export const CHATS = sql.raw(`(SELECT id, platform, key, kind, name FROM chats)`);
