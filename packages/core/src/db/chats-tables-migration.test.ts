// The 0105 migration's backfill, run on rows as they stood before it. Like
// every migration test, it writes the columns that schema had.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0105_chats_tables";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, `tag`. */
function databaseBefore(tag: string): Database.Database {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const tags = journal.entries.map((entry) => entry.tag);
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const earlier of tags.slice(0, tags.indexOf(tag))) {
    for (const statement of migrationSql(earlier)) sqlite.exec(statement);
  }
  return sqlite;
}

describe("0105_chats_tables backfill", () => {
  it("names the agent on every line from Rome, the default agent when the seat names none", () => {
    // Rows as they stood before the migration: no chats, no chat ids.
    const sqlite = databaseBefore(TAG);
    sqlite.exec(`
      INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
        VALUES ('tg', 'telegram', 'telegram', 'bot-tg', 1);
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type,
        agent_name, created_at, activity_at)
        VALUES ('channel:tg:42', 'Ada', 'channel', 'tg', '42', 'private', NULL, 10, 10);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, sender_id, created_at)
      VALUES
        ('hi', 'channel:tg:42', 'turn-1', 'user', '[{"type":"text","content":"hi"}]', 'ada', 100),
        ('hello', 'channel:tg:42', 'turn-1', 'assistant', '[{"type":"text","content":"hello"}]', NULL, 101);
    `);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(sqlite.prepare("SELECT id, sender_agent FROM chat_messages ORDER BY id").all()).toEqual([
      { id: "hello", sender_agent: "main" },
      { id: "hi", sender_agent: null },
    ]);
  });

  it("keys every direct message by both ends", () => {
    // Rows as they stood before the migration: no chats, no chat ids.
    const sqlite = databaseBefore(TAG);
    sqlite.exec(`
      INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
        VALUES ('tg', 'telegram', 'telegram', 'bot-tg', 1), ('sales', 'feishu', 'feishu', 'bot-sales', 1);
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type,
        agent_name, created_at, activity_at)
      VALUES
        ('channel:tg:42', 'Ada', 'channel', 'tg', '42', 'private', NULL, 10, 10),
        ('channel:sales:oc_p2p', 'Wei', 'channel', 'sales', 'oc_p2p', 'private', 'sales', 20, 20);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, sender_id, created_at)
      VALUES
        ('wei-hi', 'channel:sales:oc_p2p', 'turn-1', 'user', '[{"type":"text","content":"hi"}]', 'ou_wei', 100);
    `);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    // Telegram's id for a DM is the other party; Feishu's p2p id is opaque, so
    // the other party is whoever first wrote to Rome there.
    expect(
      sqlite.prepare("SELECT id, platform_chat_id, kind FROM chats ORDER BY id").all(),
    ).toEqual([
      { id: "channel:sales:oc_p2p", platform_chat_id: "dm:bot-sales:ou_wei", kind: "dm" },
      { id: "channel:tg:42", platform_chat_id: "dm:bot-tg:42", kind: "dm" },
    ]);
  });

  it("collapses a group two of Rome's accounts are in, keeps ids, and links turns", async () => {
    // Rows as they stood before the migration: no chats, no chat ids.
    const sqlite = databaseBefore(TAG);
    sqlite.exec(`
      INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
        VALUES ('sales', 'feishu', 'feishu', 'bot-sales', 1), ('support', 'feishu', 'feishu', 'bot-support', 1);
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type,
        source_thread_name, agent_name, created_at, activity_at)
      VALUES
        ('channel:sales:oc_launch', 'Launch', 'channel', 'sales', 'oc_launch', 'group', 'Launch', 'sales', 10, 10),
        ('channel:support:oc_launch', 'Launch', 'channel', 'support', 'oc_launch', 'group', 'Launch', 'support', 20, 20),
        ('chat-1', 'Dashboard', 'channel', 'webchat', 'chat-1', NULL, NULL, NULL, 30, 30);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id,
        sender_id, sender_name, context_injected_turn_id, actor, created_at)
      VALUES
        ('wei-sales', 'channel:sales:oc_launch', 'turn-7', 'user', '[{"type":"text","content":"When?"}]', 'om_1', 'ou_wei', 'Wei', NULL, NULL, 100),
        ('wei-support', 'channel:support:oc_launch', NULL, 'notification', '[{"type":"text","content":"When?"}]', 'om_1', 'ou_wei', 'Wei', 'turn-3', NULL, 100),
        ('reply', 'channel:sales:oc_launch', 'turn-7', 'assistant', '[{"type":"text","content":"Soon."}]', 'om_2', NULL, NULL, NULL, NULL, 101),
        ('trace-7', 'channel:sales:oc_launch', 'turn-7', 'trace', '[]', NULL, NULL, NULL, NULL, NULL, 100),
        ('ask', 'chat-1', 'turn-1', 'user', '[{"type":"text","content":"hi"}]', NULL, NULL, NULL, NULL,
          '{"kind":"visitor","accountId":"acct-ada","email":"ada@example.com"}', 200);
    `);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare("SELECT id, platform, platform_chat_id, kind, name FROM chats ORDER BY id")
        .all(),
    ).toEqual([
      {
        id: "channel:sales:oc_launch",
        platform: "feishu",
        platform_chat_id: "oc_launch",
        kind: "group",
        name: "Launch",
      },
      {
        id: "chat-1",
        platform: "webchat",
        // The full migration keys a dashboard chat by a digest of its id.
        platform_chat_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        kind: "dm",
        name: "Dashboard",
      },
    ]);
    expect(sqlite.prepare("SELECT id, chat_id FROM rome_sessions ORDER BY id").all()).toEqual([
      { id: "channel:sales:oc_launch", chat_id: "channel:sales:oc_launch" },
      { id: "channel:support:oc_launch", chat_id: "channel:sales:oc_launch" },
      { id: "chat-1", chat_id: "chat-1" },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT id, sender_account_id, sender_agent, sender_name, text FROM chat_messages ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "ask",
        sender_account_id: "visitor:acct-ada",
        sender_agent: null,
        sender_name: "ada@example.com",
        text: "hi",
      },
      {
        id: "reply",
        sender_account_id: "bot-sales",
        sender_agent: "sales",
        sender_name: null,
        text: "Soon.",
      },
      {
        id: "wei-sales",
        sender_account_id: "ou_wei",
        sender_agent: null,
        sender_name: "Wei",
        text: "When?",
      },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT message_id, session_id, turn_id, role FROM agent_turn_messages ORDER BY session_id, message_id",
        )
        .all(),
    ).toEqual([
      {
        message_id: "reply",
        session_id: "channel:sales:oc_launch",
        turn_id: "turn-7",
        role: "answer",
      },
      {
        message_id: "wei-sales",
        session_id: "channel:sales:oc_launch",
        turn_id: "turn-7",
        role: "prompt",
      },
      {
        message_id: "wei-sales",
        session_id: "channel:support:oc_launch",
        turn_id: "turn-3",
        role: "seen",
      },
      { message_id: "ask", session_id: "chat-1", turn_id: "turn-1", role: "prompt" },
    ]);
  });
});
