// The messages Chats has on record for one Slack conversation, read from the
// instance's database the way wipe-chat reaches it, and never written. The
// product offers no read of Chats' own record, so this reads the rows it
// keeps: each message of the chats the conversation is, by key or by address,
// as { key, text, at, thread? } in the order they were said. It uses only
// Node's built-in SQLite and opens the database read-only, so it can run
// beside the running instance (ctl.sh record pipes it into the container).
//
// Usage: node chat-record.mjs --chat <conversation id>[:<thread ts>]
//          [--member U…] [--db path] [--homes /home/rome,/home/user]
// Prints one JSON object.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
}
const [conversation, thread] = String(args.chat ?? "").split(":");
if (
  !/^[A-Z0-9]+$/.test(conversation ?? "") ||
  (thread !== undefined && !/^\d+\.\d+$/.test(thread))
) {
  fail(2, "usage: chat-record.mjs --chat <Slack conversation id>[:<thread ts>] [--member U…]");
}
const member = /^[A-Z0-9]+$/.test(args.member ?? "") ? args.member : null;
const homes = (args.homes ?? "/home/rome,/home/user").split(",").filter(Boolean);
const dbPath = args.db ?? findDatabase(homes);
if (!dbPath) fail(2, "no rome.db found under ~/.rome in the instance's homes");

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
const columns = (table) =>
  new Set(
    db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((c) => c.name),
  );
const all = (sql, ...params) => db.prepare(sql).all(...params);

// The chats the conversation is: by key, by the member's direct message key,
// or by an address that reaches it.
const chatIds = new Set();
if (columns("chats").has("key")) {
  for (const r of all("SELECT id FROM chats WHERE key = ?", conversation)) chatIds.add(r.id);
  if (member) {
    for (const r of all(
      "SELECT id FROM chats WHERE platform LIKE 'slack%' AND key LIKE 'dm:%:' || ?",
      member,
    ))
      chatIds.add(r.id);
  }
  if (columns("chat_addresses").has("address")) {
    for (const r of all(
      `SELECT c.id FROM chats c JOIN chat_addresses a
         ON a.platform = c.platform AND a.chat_key = c.key WHERE a.address = ?`,
      conversation,
    ))
      chatIds.add(r.id);
  }
}

const ids = [...chatIds];
const hasThread = columns("chat_messages").has("thread_id");
const rows = ids.length
  ? all(
      `SELECT key, text, said_at AS at, ${hasThread ? "thread_id" : "NULL"} AS thread
         FROM chat_messages WHERE chat_id IN (${ids.map(() => "?").join(",")})
         ${thread !== undefined && hasThread ? "AND (thread_id = ? OR key = ?)" : ""}
         ORDER BY said_at, id`,
      ...ids,
      ...(thread !== undefined && hasThread ? [thread, thread] : []),
    )
  : [];
db.close();

console.log(
  JSON.stringify({
    chat: args.chat,
    db: dbPath,
    chats: ids,
    messages: rows.map((r) => ({
      key: r.key,
      text: r.text,
      // Stored in seconds.
      at: new Date(Number(r.at) * 1000).toISOString(),
      ...(r.thread ? { thread: r.thread } : {}),
    })),
  }),
);

function findDatabase(roots) {
  const found = [];
  for (const root of roots) {
    const dir = join(root, ".rome");
    if (!existsSync(dir)) continue;
    for (const profile of readdirSync(dir)) {
      const path = join(dir, profile, "rome.db");
      if (existsSync(path)) found.push({ path, at: statSync(path).mtimeMs });
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.path ?? null;
}

function fail(code, error) {
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(code);
}
