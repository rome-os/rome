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
          "SELECT platform, account_id, chat_key, thread_id, address FROM chat_addresses ORDER BY platform",
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

  it("keep a line Rome said as Rome's when another account heard it first and catches up on it", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    sqlite.exec(`
      INSERT INTO rome_agent_messages (id, session_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('price-heard', 'channel:support:oc_launch', 'notification', '[{"type":"text","content":"Price is 10."}]', 'om_4', 'bot-sales', 300);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, created_at)
      VALUES ('price', 'channel:sales:oc_launch', 'turn-8', 'assistant', '[{"type":"text","content":"Price is 10."}]', 'om_4', 300);
      UPDATE rome_agent_messages SET context_injected_turn_id = 'turn-4' WHERE id = 'price-heard';
    `);

    expect(
      sqlite
        .prepare("SELECT sender_account_id, sender_agent FROM chat_messages WHERE key = 'om_4'")
        .all(),
    ).toEqual([{ sender_account_id: "bot-sales", sender_agent: "sales" }]);
  });

  it("resolve a quote recorded before the line it quotes had the platform's id", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    sqlite.exec(`
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, created_at)
      VALUES ('later', 'channel:sales:oc_launch', 'turn-9', 'assistant', '[{"type":"text","content":"Shipped."}]', 400);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id,
        reply_to_platform_message_id, created_at)
      VALUES ('thanks', 'channel:sales:oc_launch', 'turn-10', 'user', '[{"type":"text","content":"Thanks!"}]', 'om_6', 'ou_wei', 'om_5', 401);
      UPDATE rome_agent_messages SET platform_message_id = 'om_5' WHERE id = 'later';
    `);

    expect(
      sqlite
        .prepare(
          `SELECT q.text FROM chat_messages m JOIN chat_messages q ON q.id = m.reply_to_message_id
           WHERE m.key = 'om_6'`,
        )
        .all(),
    ).toEqual([{ text: "Shipped." }]);
  });

  it("move a seat first met sending into the group it turns out to be in", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    // Support wrote first, before Rome knew the place was a group, and Sales
    // heard it there.
    sqlite.exec(`
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, agent_name, created_at, activity_at)
      VALUES ('channel:support:oc_ops', 'oc_ops', 'channel', 'support', 'oc_ops', 'support', 50, 50);
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type,
        source_thread_name, agent_name, created_at, activity_at)
      VALUES ('channel:sales:oc_ops', 'Ops', 'channel', 'sales', 'oc_ops', 'group', 'Ops', 'sales', 50, 50);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, created_at)
      VALUES ('ops-hello', 'channel:support:oc_ops', 'turn-11', 'assistant', '[{"type":"text","content":"Hello ops"}]', 'om_7', 500);
      INSERT INTO rome_agent_messages (id, session_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('ops-heard', 'channel:sales:oc_ops', 'notification', '[{"type":"text","content":"Hello ops"}]', 'om_7', 'bot-support', 500);
    `);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM chat_messages WHERE text = 'Hello ops'").get(),
    ).toEqual({ n: 2 });

    sqlite.exec(
      "UPDATE rome_sessions SET source_thread_type = 'group' WHERE id = 'channel:support:oc_ops'",
    );

    expect(
      sqlite
        .prepare(
          `SELECT s.id, c.key, c.kind FROM rome_sessions s JOIN chats c ON c.id = s.chat_id
           WHERE s.source_thread_id = 'oc_ops' ORDER BY s.id`,
        )
        .all(),
    ).toEqual([
      { id: "channel:sales:oc_ops", key: "oc_ops", kind: "group" },
      { id: "channel:support:oc_ops", key: "oc_ops", kind: "group" },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT sender_account_id, sender_agent FROM chat_messages WHERE text = 'Hello ops'",
        )
        .all(),
    ).toEqual([{ sender_account_id: "bot-support", sender_agent: "support" }]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM chats WHERE kind = 'dm'").get()).toEqual({
      n: 1,
    });
  });
  it("key a direct message Rome wrote first by the person once they answer", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);
    sqlite.exec(`
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type,
        agent_name, created_at, activity_at)
      VALUES ('channel:sales:oc_p2p', 'oc_p2p', 'channel', 'sales', 'oc_p2p', 'private', 'sales', 60, 60);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, created_at)
      VALUES ('intro', 'channel:sales:oc_p2p', 'turn-12', 'assistant', '[{"type":"text","content":"Hi Wei"}]', 'om_8', 600);
    `);
    const keyOfSeat = sqlite.prepare(
      `SELECT c.key, (SELECT count(*) FROM chat_messages m WHERE m.chat_id = c.id) AS lines
       FROM rome_sessions s JOIN chats c ON c.id = s.chat_id WHERE s.id = 'channel:sales:oc_p2p'`,
    );
    expect(keyOfSeat.get()).toEqual({ key: "dm:bot-sales:oc_p2p", lines: 1 });

    sqlite.exec(`
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('wei-back', 'channel:sales:oc_p2p', 'turn-13', 'user', '[{"type":"text","content":"Hi!"}]', 'om_9', 'ou_wei', 601);
    `);

    expect(keyOfSeat.get()).toEqual({ key: "dm:bot-sales:ou_wei", lines: 2 });
    expect(
      sqlite.prepare("SELECT chat_key, address FROM chat_addresses WHERE address = 'oc_p2p'").all(),
    ).toEqual([{ chat_key: "dm:bot-sales:ou_wei", address: "oc_p2p" }]);
  });

  it("keep Rome's whole reply when another account heard only its first part", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    sqlite.exec(`
      INSERT INTO rome_agent_messages (id, session_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('stream-heard', 'channel:support:oc_launch', 'notification', '[{"type":"text","content":"The price"}]', 'om_4', 'bot-sales', 300);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, created_at)
      VALUES ('stream', 'channel:sales:oc_launch', 'turn-8', 'assistant', '[{"type":"text","content":"The price is 10."}]', 'om_4', 300);
    `);

    expect(
      sqlite.prepare("SELECT text, sender_agent FROM chat_messages WHERE key = 'om_4'").all(),
    ).toEqual([{ text: "The price is 10.", sender_agent: "sales" }]);
  });

  it("resolve a quote of a reply's later part, whether it came before that part was kept or after", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    sqlite.exec(`
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, created_at)
      VALUES ('long', 'channel:sales:oc_launch', 'turn-8', 'assistant', '[{"type":"text","content":"Part one. Part two."}]', 'om_4', 300);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id,
        reply_to_platform_message_id, created_at)
      VALUES ('re-early', 'channel:sales:oc_launch', 'turn-9', 'user', '[{"type":"text","content":"Two?"}]', 'om_6', 'ou_wei', 'om_5', 301);
      INSERT INTO rome_agent_message_platform_ids (session_id, platform_message_id, message_id)
        VALUES ('channel:sales:oc_launch', 'om_5', 'long');
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id,
        reply_to_platform_message_id, created_at)
      VALUES ('re-late', 'channel:sales:oc_launch', 'turn-10', 'user', '[{"type":"text","content":"Two!"}]', 'om_7', 'ou_wei', 'om_5', 302);
    `);

    expect(
      sqlite
        .prepare(
          `SELECT m.text, q.text AS quoted FROM chat_messages m JOIN chat_messages q ON q.id = m.reply_to_message_id
           WHERE m.key IN ('om_6', 'om_7') ORDER BY m.id`,
        )
        .all(),
    ).toEqual([
      { text: "Two?", quoted: "Part one. Part two." },
      { text: "Two!", quoted: "Part one. Part two." },
    ]);
  });

  it("name the agent account that wrote on the dashboard as its sender", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    sqlite.exec(`
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, sender_id, created_at)
      VALUES ('from-concierge', 'chat-1', 'turn-2', 'user', '[{"type":"text","content":"Done"}]', 'core:concierge', 300);
    `);

    expect(
      sqlite
        .prepare("SELECT sender_account_id FROM chat_messages WHERE key = 'from-concierge'")
        .get(),
    ).toEqual({ sender_account_id: "core:concierge" });
  });
  it("move a send-first seat's thread seats with it, and resolve quotes another seat recorded of its lines", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);
    sqlite.exec(`
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, agent_name, created_at, activity_at)
      VALUES ('channel:support:oc_ops', 'oc_ops', 'channel', 'support', 'oc_ops', 'support', 50, 50);
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type, parent_session_id,
        agent_name, created_at, activity_at)
      VALUES ('channel:support:omt_1', 'Topic', 'channel', 'support', 'omt_1', 'thread', 'channel:support:oc_ops', 'support', 51, 51);
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type, source_thread_name,
        agent_name, created_at, activity_at)
      VALUES ('channel:sales:oc_ops', 'Ops', 'channel', 'sales', 'oc_ops', 'group', 'Ops', 'sales', 52, 52);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, created_at)
      VALUES ('ops-hello', 'channel:support:oc_ops', 'turn-11', 'assistant', '[{"type":"text","content":"Hello ops"}]', 'om_7', 500),
             ('topic-hello', 'channel:support:omt_1', 'turn-12', 'assistant', '[{"type":"text","content":"In the topic"}]', 'om_8', 501);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id,
        reply_to_platform_message_id, created_at)
      VALUES ('ops-reply', 'channel:sales:oc_ops', 'turn-13', 'user', '[{"type":"text","content":"Hi support"}]', 'om_9', 'ou_wei', 'om_7', 502);
    `);

    sqlite.exec(
      "UPDATE rome_sessions SET source_thread_type = 'group' WHERE id = 'channel:support:oc_ops'",
    );

    expect(
      sqlite
        .prepare(
          `SELECT s.id, c.key, s.thread_id FROM rome_sessions s JOIN chats c ON c.id = s.chat_id
           WHERE s.id IN ('channel:support:oc_ops', 'channel:support:omt_1', 'channel:sales:oc_ops') ORDER BY s.id`,
        )
        .all(),
    ).toEqual([
      { id: "channel:sales:oc_ops", key: "oc_ops", thread_id: null },
      { id: "channel:support:oc_ops", key: "oc_ops", thread_id: null },
      { id: "channel:support:omt_1", key: "oc_ops", thread_id: "omt_1" },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT q.text FROM chat_messages m JOIN chat_messages q ON q.id = m.reply_to_message_id
           WHERE m.key = 'om_9'`,
        )
        .all(),
    ).toEqual([{ text: "Hello ops" }]);
    // Only the dashboard chat is left a direct message.
    expect(sqlite.prepare("SELECT count(*) AS n FROM chats WHERE kind = 'dm'").get()).toEqual({
      n: 1,
    });
  });

  it("move a channel's seats to its real platform and account once boot records them", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    // An install from before channels were recorded: the upgrade finds no
    // channel row and falls back to the channel's name.
    sqlite.exec(`
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type, created_at, activity_at)
      VALUES ('channel:telegram_user:4242', 'Ada', 'channel', 'telegram_user', '4242', 'private', 10, 10);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('ada-hi', 'channel:telegram_user:4242', 'turn-1', 'user', '[{"type":"text","content":"hi"}]', '5', '4242', 100);
    `);
    expect(sqlite.prepare("SELECT platform, key FROM chats").all()).toEqual([
      { platform: "telegram_user", key: "dm:telegram_user:4242" },
    ]);

    sqlite.exec(`
      INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
        VALUES ('telegram_user', 'user', 'telegram', '777', 1);
    `);

    expect(sqlite.prepare("SELECT platform, key FROM chats").all()).toEqual([
      { platform: "telegram", key: "dm:777:4242" },
    ]);
    expect(sqlite.prepare("SELECT chat_platform, account_id FROM rome_sessions").all()).toEqual([
      { chat_platform: "telegram", account_id: "777" },
    ]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM chat_messages").get()).toEqual({ n: 1 });
  });
  it("keep a later part of Rome's split reply that another account heard as the reply's one line", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    // One part heard before Rome kept it as part of the reply, one after.
    sqlite.exec(`
      INSERT INTO rome_agent_messages (id, session_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('part-heard', 'channel:support:oc_launch', 'notification', '[{"type":"text","content":"Part two."}]', 'om_5', 'bot-sales', 300);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, created_at)
      VALUES ('long', 'channel:sales:oc_launch', 'turn-8', 'assistant', '[{"type":"text","content":"Part one. Part two. Part three."}]', 'om_4', 300);
      INSERT INTO rome_agent_message_platform_ids (session_id, platform_message_id, message_id)
      VALUES ('channel:sales:oc_launch', 'om_5', 'long'), ('channel:sales:oc_launch', 'om_6', 'long');
      INSERT INTO rome_agent_messages (id, session_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('part-heard-later', 'channel:support:oc_launch', 'notification', '[{"type":"text","content":"Part three."}]', 'om_6', 'bot-sales', 301);
    `);

    expect(
      sqlite
        .prepare("SELECT key, text FROM chat_messages WHERE chat_id = 1 AND id > 2 ORDER BY id")
        .all(),
    ).toEqual([{ key: "om_4", text: "Part one. Part two. Part three." }]);
  });

  it("clear a quote once the line it quotes is gone, so a reused id never answers it", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);
    sqlite.exec(`
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type, agent_name, created_at, activity_at)
      VALUES ('channel:support:oc_ops', 'Ops', 'channel', 'support', 'oc_ops', 'group', 'support', 50, 50),
             ('channel:sales:oc_ops', 'Ops', 'channel', 'sales', 'oc_ops', 'group', 'sales', 50, 50);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('ops-ask', 'channel:support:oc_ops', 'turn-1', 'user', '[{"type":"text","content":"Ask"}]', 'om_7', 'ou_wei', 500);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id, reply_to_platform_message_id, created_at)
      VALUES ('ops-re', 'channel:sales:oc_ops', 'turn-2', 'user', '[{"type":"text","content":"Re"}]', 'om_8', 'ou_li', 'om_7', 501);
    `);
    const quote = sqlite.prepare(
      "SELECT q.text FROM chat_messages m LEFT JOIN chat_messages q ON q.id = m.reply_to_message_id WHERE m.key = 'om_8'",
    );
    expect(quote.get()).toEqual({ text: "Ask" });

    sqlite.exec(`
      DELETE FROM rome_agent_messages WHERE session_id = 'channel:support:oc_ops';
      DELETE FROM rome_sessions WHERE id = 'channel:support:oc_ops';
    `);

    expect(quote.get()).toEqual({ text: null });
  });

  it("move a seat's lines into the thread it turns out to be in", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    sqlite.exec(`
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type, agent_name, created_at, activity_at)
      VALUES ('channel:sales:omt_1', 'Topic', 'channel', 'sales', 'omt_1', 'thread', 'sales', 60, 60);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('in-topic', 'channel:sales:omt_1', 'turn-1', 'user', '[{"type":"text","content":"In the topic"}]', 'om_9', 'ou_wei', 600);
      UPDATE rome_sessions SET parent_session_id = 'channel:sales:oc_launch' WHERE id = 'channel:sales:omt_1';
    `);

    expect(
      sqlite
        .prepare(
          `SELECT s.chat_id, s.thread_id, m.chat_id AS line_chat, m.thread_id AS line_thread
           FROM rome_sessions s JOIN chat_messages m ON m.key = 'om_9' WHERE s.id = 'channel:sales:omt_1'`,
        )
        .get(),
    ).toEqual({ chat_id: 1, thread_id: "omt_1", line_chat: 1, line_thread: "omt_1" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM chats").get()).toEqual({ n: 2 });
  });

  it("name the agent linked to the account on a line from Rome when the chat names none", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    sqlite.exec(`
      INSERT INTO connections (id, connection_kind, label, created_at) VALUES ('conn-ops', 'feishu', 'Ops bot', 1);
      INSERT INTO connected_accounts (connection_id, agent) VALUES ('conn-ops', 'ops');
      INSERT INTO channels (id, connection_kind, platform, connection_id, platform_account_id, created_at)
        VALUES ('ops', 'feishu', 'feishu', 'conn-ops', 'bot-ops', 1);
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type, created_at, activity_at)
      VALUES ('channel:ops:oc_launch', 'Launch', 'channel', 'ops', 'oc_launch', 'group', 70, 70);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, created_at)
      VALUES ('ops-says', 'channel:ops:oc_launch', 'turn-1', 'assistant', '[{"type":"text","content":"On it."}]', 'om_10', 700);
    `);

    expect(
      sqlite
        .prepare("SELECT sender_account_id, sender_agent FROM chat_messages WHERE key = 'om_10'")
        .get(),
    ).toEqual({ sender_account_id: "bot-ops", sender_agent: "ops" });
  });

  it("keep a quote on its line when the quoted seat's account is learned later, and never hand its id out again", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);

    sqlite.exec(`
      INSERT INTO channels (id, connection_kind, platform, created_at) VALUES ('ops', 'feishu', 'feishu', 1);
      INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id, source_thread_type, created_at, activity_at)
      VALUES ('channel:ops:oc_launch', 'Launch', 'channel', 'ops', 'oc_launch', 'group', 70, 70);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('ops-heard', 'channel:ops:oc_launch', 'turn-1', 'user', '[{"type":"text","content":"Late news"}]', 'om_late', 'ou_wei', 700);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id, reply_to_platform_message_id, created_at)
      VALUES ('sales-re', 'channel:sales:oc_launch', 'turn-9', 'user', '[{"type":"text","content":"Re news"}]', 'om_11', 'ou_li', 'om_late', 701);
      UPDATE channels SET platform_account_id = 'bot-ops' WHERE id = 'ops';
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('ops-next', 'channel:ops:oc_launch', 'turn-2', 'user', '[{"type":"text","content":"Next"}]', 'om_12', 'ou_wei', 702);
    `);

    expect(
      sqlite
        .prepare(
          "SELECT q.key, q.text FROM chat_messages m LEFT JOIN chat_messages q ON q.id = m.reply_to_message_id WHERE m.key = 'om_11'",
        )
        .get(),
    ).toEqual({ key: "om_late", text: "Late news" });
    expect(sqlite.prepare("SELECT key FROM chat_messages ORDER BY id").all()).toEqual([
      { key: "om_1" },
      { key: "om_2" },
      { key: "ask" },
      { key: "om_11" },
      { key: "om_late" },
      { key: "om_12" },
    ]);
  });

  it("move a quote from a part another account kept on its own to the whole reply once the part is known", () => {
    const sqlite = databaseBefore(TAG);
    migrate(sqlite);
    sqlite.exec(GROUP_AND_DASHBOARD);
    sqlite.exec(`
      INSERT INTO rome_agent_messages (id, session_id, role, content, platform_message_id, sender_id, created_at)
      VALUES ('part-heard', 'channel:support:oc_launch', 'notification', '[{"type":"text","content":"Part two."}]', 'om_5', 'bot-sales', 300);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, created_at)
      VALUES ('long', 'channel:sales:oc_launch', 'turn-8', 'assistant', '[{"type":"text","content":"Part one. Part two."}]', 'om_4', 300);
      INSERT INTO rome_agent_messages (id, session_id, turn_id, role, content, platform_message_id, sender_id, reply_to_platform_message_id, created_at)
      VALUES ('re-part', 'channel:support:oc_launch', 'turn-9', 'user', '[{"type":"text","content":"Re part two"}]', 'om_7', 'ou_wei', 'om_5', 301);
    `);
    const quote = sqlite.prepare(
      "SELECT q.text FROM chat_messages m LEFT JOIN chat_messages q ON q.id = m.reply_to_message_id WHERE m.key = 'om_7'",
    );
    expect(quote.get()).toEqual({ text: "Part two." });

    sqlite.exec(`
      INSERT INTO rome_agent_message_platform_ids (session_id, platform_message_id, message_id)
      VALUES ('channel:sales:oc_launch', 'om_5', 'long');
    `);

    expect(quote.get()).toEqual({ text: "Part one. Part two." });
    expect(sqlite.prepare("SELECT key FROM chat_messages WHERE id > 2 ORDER BY id").all()).toEqual([
      { key: "om_2" },
      { key: "ask" },
      { key: "om_4" },
      { key: "om_7" },
    ]);
  });
});
