// The 0108 migration, the Chats switch's backfill, run on legacy rows as they
// stood before it. Like every migration test, it writes the columns that
// schema had.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0108_chats_backfill";

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

/** Runs the migration the way boot does: in one transaction, foreign keys on. */
function migrate(sqlite: Database.Database) {
  sqlite.transaction(() => {
    for (const statement of migrationSql(TAG)) sqlite.exec(statement);
  })();
}

const text = (content: string) => JSON.stringify([{ type: "text", content }]);

describe("0108 Chats backfill", () => {
  let sqlite: Database.Database;
  const all = (query: string) => sqlite.prepare(query).all();
  const line = (key: string) =>
    sqlite.prepare("SELECT * FROM chat_messages WHERE key = ?").get(key);
  const linkOf = (key: string, session: string) =>
    sqlite
      .prepare(
        `SELECT l.turn_id, l.role, l.input_state FROM agent_turn_messages l
         JOIN chat_messages m ON m.id = l.message_id WHERE m.key = ? AND l.session_id = ?`,
      )
      .get(key, session);

  beforeEach(() => {
    sqlite = databaseBefore(TAG);
    const channel = sqlite.prepare(
      `INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
       VALUES (?, ?, ?, ?, 1)`,
    );
    channel.run("tg-sales", "telegram", "telegram", "111");
    channel.run("tg-support", "telegram", "telegram", "222");
    channel.run("feishu", "feishu", "feishu", "bot");
    const session = sqlite.prepare(
      `INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id,
         source_thread_type, source_thread_name, parent_session_id, agent_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 100)`,
    );
    session.run("chat-1", "Plans", "channel", "webchat", "chat-1", null, null, null, "writer");
    session.run("g-sales", "Family", "channel", "tg-sales", "-42", "group", "Family", null, null);
    session.run(
      "g-support",
      "Family",
      "channel",
      "tg-support",
      "-42",
      "group",
      "Family",
      null,
      null,
    );
    session.run("dm", "Wei", "channel", "feishu", "oc_p2p", "private", null, null, null);
    session.run("group", "Launch", "channel", "feishu", "oc_launch", "group", "Launch", null, null);
    session.run("thread", "Launch", "channel", "feishu", "omt_1", "group", null, "group", null);
    session.run("fork-1", "Fork", "fork", null, null, null, null, null, null);
    const row = sqlite.prepare(
      `INSERT INTO rome_agent_messages (id, session_id, role, content, created_at, turn_id,
         input_state, platform_message_id, sender_id, sender_name, reply_to_platform_message_id,
         context_injected_turn_id, actor)
       VALUES (@id, @session, @role, @content, @at, @turn, @input, @pmid, @sender, @name, @reply,
         @seen, @actor)`,
    );
    const rows: Record<string, unknown>[] = [
      {
        id: "in-1",
        session: "chat-1",
        role: "user",
        content: text("Hi"),
        at: 200,
        turn: "t1",
        input: "accepted",
      },
      { id: "trace-1", session: "chat-1", role: "trace", content: "[]", at: 200, turn: "t1" },
      {
        id: "out-1",
        session: "chat-1",
        role: "assistant",
        content: text("Hello"),
        at: 201,
        turn: "t1",
      },
      { id: "note-1", session: "chat-1", role: "notification", content: text("Reminder"), at: 202 },
      {
        id: "in-2",
        session: "chat-1",
        role: "user",
        content: text("Status?"),
        at: 203,
        turn: "t2",
        sender: "core:concierge",
      },
      {
        id: "in-3",
        session: "chat-1",
        role: "user",
        content: text("Me too"),
        at: 204,
        actor: JSON.stringify({ kind: "visitor", accountId: "acct-ada", email: "ada@example.com" }),
      },
      {
        id: "g-1",
        session: "g-sales",
        role: "user",
        content: text("Yo"),
        at: 300,
        turn: "gt",
        pmid: "5",
        sender: "u9",
        name: "Ann",
      },
      {
        id: "g-2",
        session: "g-support",
        role: "notification",
        content: text("Yo"),
        at: 300,
        pmid: "5",
        sender: "u9",
        name: "Ann",
        seen: "st",
      },
      {
        id: "g-3",
        session: "g-sales",
        role: "assistant",
        content: text("Hey"),
        at: 301,
        turn: "gt",
        pmid: "6",
        reply: "5",
      },
      {
        id: "dm-1",
        session: "dm",
        role: "user",
        content: text("Hello bot"),
        at: 400,
        turn: "d1",
        pmid: "om_1",
        sender: "ou_wei",
        name: "Wei",
      },
      {
        id: "dm-2",
        session: "dm",
        role: "assistant",
        content: text("Part one"),
        at: 401,
        turn: "d1",
        pmid: "om_2",
      },
      {
        id: "dm-3",
        session: "dm",
        role: "user",
        content: text("About part two"),
        at: 402,
        turn: "d2",
        pmid: "om_4",
        sender: "ou_wei",
        reply: "om_3",
      },
      { id: "dm-4", session: "dm", role: "assistant", content: text("No id"), at: 403, turn: "d2" },
      {
        id: "th-1",
        session: "thread",
        role: "user",
        content: text("In the thread"),
        at: 500,
        turn: "h1",
        pmid: "om_9",
        sender: "ou_li",
      },
      {
        id: "fork-in",
        session: "fork-1",
        role: "user",
        content: text("Fork"),
        at: 600,
        turn: "f1",
      },
    ];
    for (const r of rows) {
      row.run({
        turn: null,
        input: null,
        pmid: null,
        sender: null,
        name: null,
        reply: null,
        seen: null,
        actor: null,
        ...r,
      });
    }
    // Rome sent the reply in two parts: the second part's id is the reply's.
    sqlite
      .prepare(
        `INSERT INTO rome_agent_message_platform_ids (message_id, session_id, platform_message_id)
         VALUES ('dm-2', 'dm', 'om_3')`,
      )
      .run();
    migrate(sqlite);
  });

  it("starts a chat for each place, as the adapters key it", () => {
    expect(all("SELECT platform, key, kind FROM chats ORDER BY id")).toEqual([
      { platform: "webchat", key: "chat-1", kind: "dm" },
      { platform: "feishu", key: "dm:bot:ou_wei", kind: "dm" },
      { platform: "telegram", key: "-42", kind: "group" },
      { platform: "feishu", key: "oc_launch", kind: "group" },
    ]);
  });

  it("stands each session in its chat as its account, a thread in its parent's", () => {
    expect(
      all(`SELECT s.id, c.key, s.thread_id, s.account_id FROM rome_sessions s
           LEFT JOIN chats c ON c.id = s.chat_id ORDER BY s.id`),
    ).toEqual([
      { id: "chat-1", key: "chat-1", thread_id: null, account_id: "agent:writer" },
      { id: "dm", key: "dm:bot:ou_wei", thread_id: null, account_id: "bot" },
      { id: "fork-1", key: null, thread_id: null, account_id: null },
      { id: "g-sales", key: "-42", thread_id: null, account_id: "111" },
      { id: "g-support", key: "-42", thread_id: null, account_id: "222" },
      { id: "group", key: "oc_launch", thread_id: null, account_id: "bot" },
      { id: "thread", key: "oc_launch", thread_id: "omt_1", account_id: "bot" },
    ]);
  });

  it("says a dashboard chat's prompts and answers, keyed by row, and leaves its notices and traces", () => {
    const chat = sqlite.prepare("SELECT id FROM chats WHERE key = 'chat-1'").get() as {
      id: number;
    };
    expect(
      all(`SELECT key, sender_account_id, sender_agent, sender_name, text FROM chat_messages
           WHERE chat_id = ${chat.id} ORDER BY id`),
    ).toEqual([
      {
        key: "in-1",
        sender_account_id: "guardian",
        sender_agent: null,
        sender_name: null,
        text: "Hi",
      },
      {
        key: "out-1",
        sender_account_id: "agent:writer",
        sender_agent: "writer",
        sender_name: null,
        text: "Hello",
      },
      {
        key: "in-2",
        sender_account_id: "agent:core:concierge",
        sender_agent: "core:concierge",
        sender_name: null,
        text: "Status?",
      },
      {
        key: "in-3",
        sender_account_id: "visitor:acct-ada",
        sender_agent: null,
        sender_name: "ada@example.com",
        text: "Me too",
      },
    ]);
    expect(linkOf("in-1", "chat-1")).toEqual({
      turn_id: "t1",
      role: "prompt",
      input_state: "accepted",
    });
    expect(linkOf("out-1", "chat-1")).toEqual({ turn_id: "t1", role: "answer", input_state: null });
  });

  it("keeps a Telegram basic group's line once per account that heard it", () => {
    expect(line("111:5")).toMatchObject({
      sender_account_id: "u9",
      sender_name: "Ann",
      text: "Yo",
    });
    expect(line("222:5")).toMatchObject({ sender_account_id: "u9" });
    expect(linkOf("111:5", "g-sales")).toEqual({
      turn_id: "gt",
      role: "prompt",
      input_state: null,
    });
    expect(linkOf("222:5", "g-support")).toEqual({
      turn_id: "st",
      role: "seen",
      input_state: null,
    });
    const reply = line("111:6") as { reply_to_message_id: number; sender_agent: string };
    expect(reply.sender_agent).toBe("main");
    expect(reply.reply_to_message_id).toBe((line("111:5") as { id: number }).id);
  });

  it("notes each heard line as reached by the account that heard it", () => {
    expect(
      all(`SELECT m.key, d.account_id FROM chat_message_deliveries d
           JOIN chat_messages m ON m.id = d.message_id ORDER BY m.id`),
    ).toEqual([
      { key: "111:5", account_id: "111" },
      { key: "222:5", account_id: "222" },
      { key: "om_1", account_id: "bot" },
      { key: "om_4", account_id: "bot" },
      { key: "om_9", account_id: "bot" },
    ]);
  });

  it("resolves a quote of a later part of a reply to the reply's line", () => {
    const quote = line("om_4") as { reply_to_message_id: number };
    expect(quote.reply_to_message_id).toBe((line("om_2") as { id: number }).id);
  });

  it("keys a line the platform gave no id by one of Rome's own", () => {
    expect(line("rome:dm-4")).toMatchObject({ sender_account_id: "bot", text: "No id" });
  });

  it("keeps where each account reaches a direct message and a thread", () => {
    expect(
      all(
        "SELECT platform, account_id, chat_key, thread_id, address FROM chat_addresses ORDER BY thread_id",
      ),
    ).toEqual([
      {
        platform: "feishu",
        account_id: "bot",
        chat_key: "dm:bot:ou_wei",
        thread_id: "",
        address: "oc_p2p",
      },
      {
        platform: "feishu",
        account_id: "bot",
        chat_key: "oc_launch",
        thread_id: "omt_1",
        address: "omt_1",
      },
    ]);
  });

  it("leaves a fork's rows its own and every legacy row in place", () => {
    expect(line("fork-in")).toBeUndefined();
    expect(all("SELECT count(*) AS n FROM rome_agent_messages")).toEqual([{ n: 15 }]);
    expect(all("SELECT name FROM sqlite_master WHERE name LIKE 'legacy_chat%'")).toEqual([]);
  });
});
