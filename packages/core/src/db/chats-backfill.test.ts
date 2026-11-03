// The Chats switch's backfill, run on legacy rows in a database at the latest
// schema, the way startup runs it: in one transaction, foreign keys on.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "@rstest/core";
import { LEGACY_CHATS_BACKFILL } from "./chats-backfill.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");

/** A database every migration has run on. */
function migratedDatabase(): Database.Database {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const { tag } of journal.entries) {
    for (const statement of readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .map((each) => each.trim())
      .filter(Boolean)) {
      sqlite.exec(statement);
    }
  }
  return sqlite;
}

/** Runs the backfill as startup does: in one transaction. */
function backfill(sqlite: Database.Database) {
  sqlite.transaction(() => {
    for (const statement of LEGACY_CHATS_BACKFILL) sqlite.exec(statement);
  })();
}

const text = (content: string) => JSON.stringify([{ type: "text", content }]);

describe("Chats backfill", () => {
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
    sqlite = migratedDatabase();
    const channel = sqlite.prepare(
      `INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
       VALUES (?, ?, ?, ?, 1)`,
    );
    channel.run("tg-sales", "telegram", "telegram", "111");
    channel.run("tg-support", "telegram", "telegram", "222");
    channel.run("feishu", "feishu", "feishu", "bot");
    channel.run("mail", "email", "email", "rome@example.com");
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
    // Rows an app opened without naming a type: the address tells a Telegram
    // group from a direct message.
    session.run("tg-dm", "Ada", "channel", "tg-sales", "55", null, null, null, null);
    session.run("tg-group", "Club", "channel", "tg-sales", "-77", null, "Club", null, null);
    // An email thread, which a send opened as private.
    session.run("mail-1", "Invoice", "channel", "mail", "thr-1", "private", "Invoice", null, null);
    // A send opened every new address as private, a group's too.
    session.run("tg-sent", "Crew", "channel", "tg-sales", "-88", "private", "Crew", null, null);
    // A chat heard on a channel that knows no account: it waits until the
    // channel does.
    session.run("tgu-dm", "Bo", "channel", "telegram_user", "99", null, null, null, null);
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
      // Support's own messages, numbered by its account as Sales numbers its.
      {
        id: "g-4",
        session: "g-support",
        role: "notification",
        content: text("Six"),
        at: 302,
        pmid: "6",
        sender: "u10",
        name: "Bo",
      },
      {
        id: "g-5",
        session: "g-support",
        role: "notification",
        content: text("Seven"),
        at: 303,
        pmid: "7",
        sender: "u10",
        name: "Bo",
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
         VALUES ('dm-2', 'dm', 'om_3'), ('g-3', 'g-sales', '7')`,
      )
      .run();
    // Concierge tasks pointing back to a legacy row, and to one long gone.
    const task = sqlite.prepare(
      `INSERT INTO concierge_tasks (id, title, state, legacy_source_message_id, created_at, updated_at)
       VALUES (?, ?, 'next', ?, 1, 1)`,
    );
    task.run("task-1", "Answer", "out-1");
    task.run("task-2", "Gone", "deleted-row");
    // The thread's first message reached Rome after the platform dated it.
    sqlite.prepare("UPDATE rome_sessions SET created_at = 550 WHERE id = 'thread'").run();
    // Support's first message came in the second its session was made.
    sqlite.prepare("UPDATE rome_sessions SET created_at = 300 WHERE id = 'g-support'").run();
    backfill(sqlite);
  });

  it("starts a chat for each place, as the adapters key it, a group by its address", () => {
    expect(all("SELECT platform, key, kind FROM chats ORDER BY id")).toEqual([
      { platform: "webchat", key: "chat-1", kind: "dm" },
      { platform: "feishu", key: "dm:bot:ou_wei", kind: "dm" },
      { platform: "telegram", key: "-42", kind: "group" },
      { platform: "feishu", key: "oc_launch", kind: "group" },
      { platform: "email", key: "thr-1", kind: "group" },
      { platform: "telegram", key: "dm:111:55", kind: "dm" },
      { platform: "telegram", key: "-77", kind: "group" },
      { platform: "telegram", key: "-88", kind: "group" },
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
      { id: "mail-1", key: "thr-1", thread_id: null, account_id: "rome@example.com" },
      { id: "tg-dm", key: "dm:111:55", thread_id: null, account_id: "111" },
      { id: "tg-group", key: "-77", thread_id: null, account_id: "111" },
      { id: "tg-sent", key: "-88", thread_id: null, account_id: "111" },
      { id: "tgu-dm", key: null, thread_id: null, account_id: null },
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

  it("keeps a Telegram basic group's message once per account that heard it", () => {
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

  it("reads a basic group's reply aliases only for the account that holds them", () => {
    // Sales sent its reply as its 6 and 7; Support's own 6 and 7 are other messages.
    expect(line("111:6")).toMatchObject({ text: "Hey" });
    expect(line("222:6")).toMatchObject({ text: "Six" });
    expect(line("222:7")).toMatchObject({ text: "Seven" });
    expect(line("111:7")).toBeUndefined();
  });

  it("keeps in view a first message dated before or in the second its session was made", () => {
    // Catch-up reads messages said after the speaker's second, so each migrated
    // speaker starts the second before its first message.
    expect(
      all("SELECT id, created_at FROM rome_sessions WHERE id IN ('thread', 'g-support', 'dm')"),
    ).toEqual(
      expect.arrayContaining([
        { id: "thread", created_at: 499 },
        { id: "g-support", created_at: 299 },
        { id: "dm", created_at: 100 },
      ]),
    );
    expect(
      all(`SELECT s.id FROM rome_sessions s
           WHERE s.type = 'channel' AND s.created_at >= (
             SELECT min(m.created_at) FROM rome_agent_messages m WHERE m.session_id = s.id)`),
    ).toEqual([]);
  });

  it("resolves a quote of a later part of a reply to the reply's message", () => {
    const quote = line("om_4") as { reply_to_message_id: number };
    expect(quote.reply_to_message_id).toBe((line("om_2") as { id: number }).id);
  });

  it("resolves a quote of a later part of a reply an earlier pass moved", () => {
    const session = sqlite.prepare(
      `INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id,
         source_thread_type, created_at)
       VALUES (?, 'Ops', 'channel', ?, 'oc_ops', 'group', 100)`,
    );
    const row = sqlite.prepare(
      `INSERT INTO rome_agent_messages (id, session_id, role, content, created_at,
         platform_message_id, sender_id, reply_to_platform_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // One account's reply in a Feishu group, sent in two parts.
    session.run("ops-a", "feishu");
    row.run("ops-1", "ops-a", "assistant", text("Part one"), 700, "om_20", null, null);
    sqlite
      .prepare(
        `INSERT INTO rome_agent_message_platform_ids (message_id, session_id, platform_message_id)
         VALUES ('ops-1', 'ops-a', 'om_21')`,
      )
      .run();
    backfill(sqlite);
    // Another account in the group, whose channel learned its account after
    // that pass, heard a quote of the second part.
    sqlite
      .prepare(
        `INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
         VALUES ('feishu-2', 'feishu', 'feishu', 'bot2', 1)`,
      )
      .run();
    session.run("ops-b", "feishu-2");
    row.run(
      "ops-2",
      "ops-b",
      "notification",
      text("About part two"),
      710,
      "om_22",
      "ou_li",
      "om_21",
    );

    backfill(sqlite);

    const quote = line("om_22") as { reply_to_message_id: number };
    expect(quote.reply_to_message_id).toBe((line("om_20") as { id: number }).id);
  });

  it("starts a group where two people wrote, though a send opened it as private", () => {
    sqlite
      .prepare(
        `INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
         VALUES ('discord', 'discord', 'discord', 'dbot', 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO rome_sessions (id, name, type, source_channel, source_thread_id,
           source_thread_type, created_at)
         VALUES ('dc-sent', 'General', 'channel', 'discord', '9001', 'private', 100)`,
      )
      .run();
    const row = sqlite.prepare(
      `INSERT INTO rome_agent_messages (id, session_id, role, content, created_at,
         platform_message_id, sender_id)
       VALUES (?, 'dc-sent', ?, ?, ?, ?, ?)`,
    );
    row.run("dc-1", "assistant", text("Hello all"), 800, "d1", null);
    row.run("dc-2", "user", text("Hi"), 801, "d2", "u1");
    row.run("dc-3", "notification", text("Yo"), 802, "d3", "u2");

    backfill(sqlite);

    expect(
      all(`SELECT c.key, c.kind FROM rome_sessions s JOIN chats c ON c.id = s.chat_id
           WHERE s.id = 'dc-sent'`),
    ).toEqual([{ key: "9001", kind: "group" }]);
  });

  it("points a Concierge task at the message its legacy row became", () => {
    expect(
      all(
        `SELECT t.id, m.key, t.legacy_source_message_id AS legacy FROM concierge_tasks t
         LEFT JOIN chat_messages m ON m.id = t.source_message_id ORDER BY t.id`,
      ),
    ).toEqual([
      { id: "task-1", key: "out-1", legacy: null },
      { id: "task-2", key: null, legacy: "deleted-row" },
    ]);
  });

  it("keys a message the platform gave no id by one of Rome's own", () => {
    expect(line("rome:dm-4")).toMatchObject({ sender_account_id: "bot", text: "No id" });
  });

  it("keeps where each account reaches a direct message and a thread", () => {
    expect(
      all(
        `SELECT platform, account_id, chat_key, thread_id, address FROM chat_addresses
         ORDER BY thread_id, chat_key`,
      ),
    ).toEqual([
      {
        platform: "telegram",
        account_id: "111",
        chat_key: "dm:111:55",
        thread_id: "",
        address: "55",
      },
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
    expect(all("SELECT count(*) AS n FROM rome_agent_messages")).toEqual([{ n: 17 }]);
    expect(all("SELECT name FROM sqlite_master WHERE name LIKE 'legacy_chat%'")).toEqual([]);
    expect(all("SELECT name FROM sqlite_temp_master WHERE name LIKE 'legacy_chat%'")).toEqual([]);
  });

  it("moves a channel's sessions once it knows its account, and nothing twice", () => {
    const before = all("SELECT id, chat_id, key FROM chat_messages ORDER BY id");
    sqlite
      .prepare(
        `INSERT INTO channels (id, connection_kind, platform, platform_account_id, created_at)
         VALUES ('telegram_user', 'telegram_user', 'telegram', '333', 1)`,
      )
      .run();

    backfill(sqlite);

    // The sessions moved before keep their messages as they were.
    expect(all("SELECT id, chat_id, key FROM chat_messages ORDER BY id")).toEqual(before);
    expect(
      all(`SELECT c.platform, c.key, c.kind, s.account_id FROM rome_sessions s
           JOIN chats c ON c.id = s.chat_id WHERE s.id = 'tgu-dm'`),
    ).toEqual([{ platform: "telegram", key: "dm:333:99", kind: "dm", account_id: "333" }]);
    backfill(sqlite);
    expect(all("SELECT count(*) AS n FROM chats")).toEqual([{ n: 9 }]);
  });
});
