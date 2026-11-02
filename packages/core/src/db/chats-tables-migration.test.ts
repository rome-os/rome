// The 0105 migration: its backfill, run on rows as they stood before it, and
// the triggers that copy legacy rows written after it. Like every migration
// test, it writes the columns that schema had.

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

const GROUP_AND_DASHBOARD_CHATS = [
  { id: 1, platform: "feishu", key: "oc_launch", kind: "group", name: "Launch" },
  { id: 2, platform: "webchat", key: "chat-1", kind: "dm", name: "Dashboard" },
];

const GROUP_AND_DASHBOARD_LINES = [
  {
    id: 1,
    chat_id: 1,
    key: "om_1",
    sender_account_id: "ou_wei",
    sender_agent: null,
    sender_name: "Wei",
    text: "When?",
    reply_to_message_id: null,
  },
  {
    id: 2,
    chat_id: 1,
    key: "om_2",
    sender_account_id: "bot-sales",
    sender_agent: "sales",
    sender_name: null,
    text: "Soon.",
    reply_to_message_id: 1,
  },
  {
    id: 3,
    chat_id: 2,
    key: "ask",
    sender_account_id: "visitor:acct-ada",
    sender_agent: null,
    sender_name: "ada@example.com",
    text: "hi",
    reply_to_message_id: null,
  },
];

const GROUP_AND_DASHBOARD_LINKS = [
  { message_id: 1, session_id: "channel:sales:oc_launch", turn_id: "turn-7", role: "prompt" },
  { message_id: 2, session_id: "channel:sales:oc_launch", turn_id: "turn-7", role: "answer" },
  { message_id: 1, session_id: "channel:support:oc_launch", turn_id: "turn-3", role: "seen" },
  { message_id: 3, session_id: "chat-1", turn_id: "turn-1", role: "prompt" },
];

function chatsOf(sqlite: Database.Database) {
  return sqlite.prepare("SELECT id, platform, key, kind, name FROM chats ORDER BY id").all();
}

function linesOf(sqlite: Database.Database) {
  return sqlite
    .prepare(
      `SELECT id, chat_id, key, sender_account_id, sender_agent, sender_name, text, reply_to_message_id
       FROM chat_messages ORDER BY id`,
    )
    .all();
}

function linksOf(sqlite: Database.Database) {
  return sqlite
    .prepare(
      "SELECT message_id, session_id, turn_id, role FROM agent_turn_messages ORDER BY session_id, message_id",
    )
    .all();
}

describe("0105_chats_tables backfill", () => {
  it("records a group two of Rome's accounts are in as one chat, each line once, with each seat's turn links", () => {
    const sqlite = databaseBefore(TAG);
    sqlite.exec(GROUP_AND_DASHBOARD);

    migrate(sqlite);

    expect(chatsOf(sqlite)).toEqual(GROUP_AND_DASHBOARD_CHATS);
    expect(
      sqlite
        .prepare("SELECT id, chat_id, chat_platform, account_id FROM rome_sessions ORDER BY id")
        .all(),
    ).toEqual([
      {
        id: "channel:sales:oc_launch",
        chat_id: 1,
        chat_platform: "feishu",
        account_id: "bot-sales",
      },
      {
        id: "channel:support:oc_launch",
        chat_id: 1,
        chat_platform: "feishu",
        account_id: "bot-support",
      },
      { id: "chat-1", chat_id: 2, chat_platform: "webchat", account_id: "agent:main" },
    ]);
    // The trace stays a legacy row; it was never said in the chat.
    expect(linesOf(sqlite)).toEqual(GROUP_AND_DASHBOARD_LINES);
    expect(linksOf(sqlite)).toEqual(GROUP_AND_DASHBOARD_LINKS);
    // The legacy rows stay until the contract migration.
    expect(sqlite.prepare("SELECT count(*) AS n FROM rome_agent_messages").get()).toEqual({
      n: 5,
    });
  });

  it("keys every direct message by both ends and keeps where each account reaches it", () => {
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

    migrate(sqlite);

    // Telegram's id for a DM is the other party; Feishu's p2p id is opaque, so
    // the other party is whoever first wrote to Rome there.
    expect(sqlite.prepare("SELECT platform, key, kind FROM chats ORDER BY id").all()).toEqual([
      { platform: "telegram", key: "dm:bot-tg:42", kind: "dm" },
      { platform: "feishu", key: "dm:bot-sales:ou_wei", kind: "dm" },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT platform, account_id, chat_key, thread_id, address FROM channel_addresses ORDER BY platform",
        )
        .all(),
    ).toEqual([
      {
        platform: "feishu",
        account_id: "bot-sales",
        chat_key: "dm:bot-sales:ou_wei",
        thread_id: "",
        address: "oc_p2p",
      },
      {
        platform: "telegram",
        account_id: "bot-tg",
        chat_key: "dm:bot-tg:42",
        thread_id: "",
        address: "42",
      },
    ]);
  });
});

describe("0105_chats_tables triggers", () => {
  it("copy a legacy row written after the upgrade as the backfill would have", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);

    sqlite.exec(GROUP_AND_DASHBOARD);

    expect(chatsOf(sqlite)).toEqual(GROUP_AND_DASHBOARD_CHATS);
    expect(linesOf(sqlite)).toEqual(GROUP_AND_DASHBOARD_LINES);
    expect(linksOf(sqlite)).toEqual(GROUP_AND_DASHBOARD_LINKS);
  });

  it("join Rome's reply to the line another account heard once the platform's id arrives", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    // Recorded before delivery, with no platform id yet, while the other
    // account already heard it.
    sqlite.exec(`
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, created_at)
      VALUES ('done', 'channel:sales:oc_launch', 'turn-8', 'assistant', '[{"type":"text","content":"Done."}]', 300);
      INSERT INTO rome_agent_messages (id, session_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('done-heard', 'channel:support:oc_launch', 'notification', '[{"type":"text","content":"Done."}]', 'om_3', 'bot-sales', 300);
    `);
    expect(
      sqlite.prepare("SELECT key FROM chat_messages WHERE text = 'Done.' ORDER BY id").all(),
    ).toEqual([{ key: "done" }, { key: "om_3" }]);

    sqlite.exec("UPDATE rome_agent_messages SET platform_message_id = 'om_3' WHERE id = 'done'");

    expect(
      sqlite.prepare("SELECT id, key FROM chat_messages WHERE text = 'Done.' ORDER BY id").all(),
    ).toEqual([{ id: 5, key: "om_3" }]);
    expect(
      sqlite
        .prepare("SELECT session_id, turn_id, role FROM agent_turn_messages WHERE message_id = 5")
        .all(),
    ).toEqual([{ session_id: "channel:sales:oc_launch", turn_id: "turn-8", role: "answer" }]);
  });

  it("follow a renamed chat, and a deleted one", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    sqlite.exec("UPDATE rome_sessions SET name = 'Renamed' WHERE id = 'chat-1'");
    expect(sqlite.prepare("SELECT name FROM chats WHERE id = 2").get()).toEqual({
      name: "Renamed",
    });

    // A chat's rows go before its row, as the repositories delete them.
    sqlite.exec(`
      DELETE FROM rome_agent_messages WHERE session_id = 'chat-1';
      DELETE FROM rome_sessions WHERE id = 'chat-1';
    `);

    expect(sqlite.prepare("SELECT id FROM chats ORDER BY id").all()).toEqual([{ id: 1 }]);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM chat_messages WHERE chat_id = 2").get(),
    ).toEqual({ n: 0 });
    expect(
      sqlite
        .prepare("SELECT count(*) AS n FROM agent_turn_messages WHERE session_id = 'chat-1'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("make a promoted fork a chat with the lines it already holds", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);
    sqlite.exec(`
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, parent_session_id,
        created_at, activity_at)
        VALUES ('fork-1', 'Branch', 'fork', 'webchat', 'chat-1', 'chat-1', 40, 40);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, created_at)
      VALUES ('branch-ask', 'fork-1', 'turn-9', 'user', '[{"type":"text","content":"what if"}]', 400);
    `);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM chat_messages WHERE key = 'branch-ask'").get(),
    ).toEqual({ n: 0 });

    sqlite.exec(
      "UPDATE rome_sessions SET type = 'channel', source_thread_id = id WHERE id = 'fork-1'",
    );

    expect(
      sqlite
        .prepare(
          `SELECT c.platform, c.key, m.text, l.role FROM chat_messages m
           JOIN chats c ON c.id = m.chat_id JOIN agent_turn_messages l ON l.message_id = m.id
           WHERE l.session_id = 'fork-1'`,
        )
        .all(),
    ).toEqual([{ platform: "webchat", key: "fork-1", text: "what if", role: "prompt" }]);
  });
});
