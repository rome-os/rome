// The 0105 migration adds Chats' tables empty, beside the legacy rows. Like
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

function migrate(sqlite: Database.Database) {
  for (const statement of migrationSql(TAG)) sqlite.exec(statement);
}

// Two of Rome's Feishu accounts in one group, and a visitor on the dashboard.
const GROUP_AND_DASHBOARD = `
  INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
    VALUES ('sales', 'feishu', 'feishu', 'bot-sales', 1), ('support', 'feishu', 'feishu', 'bot-support', 1);
  INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type,
    source_thread_name, agent_name, created_at, activity_at)
  VALUES
    ('channel:sales:oc_launch', 'Launch', 'channel', 'sales', 'oc_launch', 'group', 'Launch', 'sales', 10, 10),
    ('channel:support:oc_launch', 'Launch', 'channel', 'support', 'oc_launch', 'group', 'Launch', 'support', 20, 20),
    ('chat-1', 'Dashboard', 'channel', 'webchat', 'chat-1', NULL, NULL, NULL, 30, 30);
  INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id,
    sender_id, sender_name, reply_to_platform_message_id, context_injected_turn_id, actor, created_at)
  VALUES
    ('wei-sales', 'channel:sales:oc_launch', 'turn-7', 'user', '[{"type":"text","content":"When?"}]', 'om_1', 'ou_wei', 'Wei', NULL, NULL, NULL, 100),
    ('wei-support', 'channel:support:oc_launch', NULL, 'notification', '[{"type":"text","content":"When?"}]', 'om_1', 'ou_wei', 'Wei', NULL, 'turn-3', NULL, 100),
    ('reply', 'channel:sales:oc_launch', 'turn-7', 'assistant', '[{"type":"text","content":"Soon."}]', 'om_2', NULL, NULL, 'om_1', NULL, NULL, 101),
    ('trace-7', 'channel:sales:oc_launch', 'turn-7', 'trace', '[]', NULL, NULL, NULL, NULL, NULL, NULL, 100),
    ('ask', 'chat-1', 'turn-1', 'user', '[{"type":"text","content":"hi"}]', NULL, NULL, NULL, NULL, NULL,
      '{"kind":"visitor","accountId":"acct-ada","email":"ada@example.com"}', 200);
`;

describe("0105_chats_tables", () => {
  it("add Chats' tables empty and leave the legacy rows as they were", () => {
    const sqlite = databaseBefore(TAG);
    sqlite.exec(GROUP_AND_DASHBOARD);
    const legacy = () => ({
      sessions: sqlite.prepare("SELECT * FROM rome_sessions ORDER BY id").all(),
      messages: sqlite.prepare("SELECT * FROM rome_agent_messages ORDER BY id").all(),
    });
    const before = legacy();

    migrate(sqlite);

    for (const table of ["chats", "chat_messages", "agent_turn_messages", "chat_addresses"]) {
      expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    const after = legacy();
    expect(after.messages).toEqual(before.messages);
    expect(
      (after.sessions as Record<string, unknown>[]).map(
        ({ chat_id, chat_platform, thread_id, account_id, ...rest }) => {
          expect([chat_id, chat_platform, thread_id, account_id]).toEqual([null, null, null, null]);
          return rest;
        },
      ),
    ).toEqual(before.sessions);
  });

  it("keep one line per key in a chat, and take a chat's lines and turn links with it", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(`
      INSERT INTO chats (platform, key, kind, started_at) VALUES ('feishu', 'oc_launch', 'group', 10);
      INSERT INTO chat_messages (chat_id, key, text, parts, said_at) VALUES (1, 'om_1', 'When?', '[]', 100);
      INSERT INTO agent_turn_messages (message_id, session_id, turn_id, role) VALUES (1, 'channel:sales:oc_launch', 'turn-7', 'prompt');
    `);

    expect(() =>
      sqlite.exec(
        "INSERT INTO chat_messages (chat_id, key, text, parts, said_at) VALUES (1, 'om_1', 'again', '[]', 101)",
      ),
    ).toThrow(/UNIQUE/);

    sqlite.exec("DELETE FROM chats WHERE id = 1");
    expect(sqlite.prepare("SELECT count(*) AS n FROM chat_messages").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM agent_turn_messages").get()).toEqual({ n: 0 });

    // A deleted line's id is never handed out again.
    sqlite.exec(`
      INSERT INTO chats (platform, key, kind, started_at) VALUES ('feishu', 'oc_launch', 'group', 10);
      INSERT INTO chat_messages (chat_id, key, text, parts, said_at) VALUES (2, 'om_1', 'When?', '[]', 100);
    `);
    expect(sqlite.prepare("SELECT id FROM chat_messages").get()).toEqual({ id: 2 });
  });
});
