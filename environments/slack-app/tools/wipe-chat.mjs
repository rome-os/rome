// Wipes Rome's copy of one Slack conversation from a stopped instance, for R13:
// everything Rome keeps of that chat's messages, the Slack app connection's own
// copy included. The product offers no way to do this, so it works on the
// database directly. It runs inside the instance's image with the instance
// stopped (ctl.sh wipe-chat does both), and it uses only Node's built-in SQLite.
//
// What goes:
// - the connection's copy, on a Rome whose connection still keeps one:
//   slack_app_messages of the conversation (a missing table is skipped)
// - the chat's record of what was said: chat_messages (and agent_turn_messages)
//   of the chats the conversation is, by key or by address
// - the chat's conversations with Rome's agents: every rome_sessions row whose
//   address is the conversation or whose chat is one of those chats, its
//   sub-sessions, and the rows that are theirs (the session delete in
//   webchat/repository.ts lists them)
// - the agent provider sessions of those conversations and their transcripts on
//   disk, so a new message starts a model thread that knows nothing of the old
// - then, by what they hold rather than by name, every other row that names the
//   conversation or holds the text of a wiped message: the connection's other
//   tables (such as slack_app_timeline), and the approvals and action runs whose
//   payloads quote what was said. Texts under 8 characters are not looked for.
// - with --text (repeatable), any row and any file under the homes (memory
//   included) that holds one of the given texts: what Rome distilled from the
//   chat. A file loses the lines that hold one; a transcript goes whole.
// What stays: the chat's place and address (chats, chat_addresses), which hold
// no message, and the connection itself.
//
// Afterwards every text column of every table is searched again. It exits 3
// when a copy is still found, 0 when none is.
//
// Usage: node wipe-chat.mjs --conversation D… [--member U…] [--db path]
//          [--homes /home/rome,/home/user] [--text "…"]... [--dry-run]
// Prints one JSON object.

import {
  chownSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = parseArgs(process.argv.slice(2));
const conversation = args.conversation;
if (!conversation || !/^[A-Z0-9]+$/.test(conversation)) {
  fail(2, "usage: wipe-chat.mjs --conversation <Slack conversation id> [--member U…] [--db path]");
}
const member = args.member && /^[A-Z0-9]+$/.test(args.member) ? args.member : null;
const homes = (args.homes ?? "/home/rome,/home/user").split(",").filter(Boolean);
const dryRun = Boolean(args["dry-run"]);
// Texts Rome may have distilled from the chat (a fact's value, say), to remove
// wherever they are, memory files included. Short ones would match ids and
// hashes, so each must be 8 characters or more.
const extraTexts = Array.isArray(args.text) ? args.text : [];
if (extraTexts.some((t) => t.length < 8)) fail(2, "each --text must be 8 characters or more");
const dbPath = args.db ?? findDatabase(homes);
if (!dbPath) fail(2, "no rome.db found under ~/.rome in the instance's homes");

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
const schema = readSchema(db);
const has = (table, column) => schema.get(table)?.has(column) ?? false;
const placeholders = (list) => list.map(() => "?").join(",");
// The chat's place and address: they name the conversation and hold no message.
const PLACES = new Set(["chats", "chat_addresses"]);
// Tables no message is ever copied into, which a text could match by accident.
const NEVER = new Set(["__drizzle_migrations"]);
const all = (sql, ...params) => db.prepare(sql).all(...params);

// ---- What is the chat's
const chatIds = new Set();
if (has("chats", "key")) {
  for (const r of all("SELECT id FROM chats WHERE key = ?", conversation)) chatIds.add(r.id);
  if (member) {
    for (const r of all(
      "SELECT id FROM chats WHERE platform LIKE 'slack%' AND key LIKE 'dm:%:' || ?",
      member,
    ))
      chatIds.add(r.id);
  }
  if (has("chat_addresses", "address")) {
    for (const r of all(
      `SELECT c.id FROM chats c JOIN chat_addresses a
         ON a.platform = c.platform AND a.chat_key = c.key WHERE a.address = ?`,
      conversation,
    ))
      chatIds.add(r.id);
  }
}

const sessionIds = new Set();
if (has("rome_sessions", "id")) {
  const like = `%:${conversation}`;
  for (const r of all(
    `SELECT id FROM rome_sessions
      WHERE id LIKE 'channel:%:' || ? OR id LIKE 'channel:%:' || ? || ':%'
         OR source_thread_id = ? OR source_thread_id LIKE ? || ':%' OR source_thread_id LIKE ?`,
    conversation,
    conversation,
    conversation,
    conversation,
    like,
  ))
    sessionIds.add(r.id);
  if (chatIds.size && has("rome_sessions", "chat_id")) {
    const ids = [...chatIds];
    for (const r of all(
      `SELECT id FROM rome_sessions WHERE chat_id IN (${placeholders(ids)})`,
      ...ids,
    ))
      sessionIds.add(r.id);
  }
  // Sub-sessions (subagents, forks) carry the chat's words too.
  for (let grew = true; grew && has("rome_sessions", "parent_session_id"); ) {
    grew = false;
    const ids = [...sessionIds];
    if (!ids.length) break;
    for (const r of all(
      `SELECT id FROM rome_sessions WHERE parent_session_id IN (${placeholders(ids)})`,
      ...ids,
    )) {
      if (!sessionIds.has(r.id)) {
        sessionIds.add(r.id);
        grew = true;
      }
    }
  }
}

const providerSessions = new Map(); // sessions.id -> provider thread id
if (has("sessions", "id")) {
  const ids = [...sessionIds];
  const byChat =
    ids.length && has("sessions", "chat_id")
      ? all(
          `SELECT id, provider_thread_id AS thread FROM sessions WHERE chat_id IN (${placeholders(ids)})`,
          ...ids,
        )
      : [];
  const byKey = has("sessions", "channel_thread_key")
    ? all(
        "SELECT id, provider_thread_id AS thread FROM sessions WHERE instr(channel_thread_key, ?) > 0",
        conversation,
      )
    : [];
  for (const r of [...byChat, ...byKey]) providerSessions.set(r.id, r.thread);
}

// The words being wiped, to look for copies of them anywhere else afterwards.
const words = new Set();
const collect = (sql, ...params) => {
  for (const r of all(sql, ...params))
    if (typeof r.t === "string" && r.t.length >= 8) words.add(r.t);
};
if (has("slack_app_messages", "text"))
  collect("SELECT text AS t FROM slack_app_messages WHERE channel_id = ?", conversation);
if (chatIds.size && has("chat_messages", "text")) {
  const ids = [...chatIds];
  collect(`SELECT text AS t FROM chat_messages WHERE chat_id IN (${placeholders(ids)})`, ...ids);
}

// What a copy holds: the conversation id, or a wiped text as stored or
// JSON-escaped. Kept in a table, so a query holds one predicate per column
// however many texts there are.
db.exec("CREATE TEMP TABLE wipe_needles (v TEXT NOT NULL)");
const addNeedle = db.prepare("INSERT INTO temp.wipe_needles (v) VALUES (?)");
for (const needle of new Set([conversation, ...escapedToo(words), ...escapedToo(extraTexts)]))
  addNeedle.run(needle);
/** A condition true when any of `table`'s `columns` holds a needle. */
const holdsNeedle = (table, columns) =>
  `EXISTS (SELECT 1 FROM temp.wipe_needles n WHERE ${columns.map((c) => `instr("${table}"."${c}", n.v) > 0`).join(" OR ")})`;
// The words alone, without the conversation id: a place or address naming the
// conversation is kept, but one holding a word, such as a chat's title, is not.
db.exec("CREATE TEMP TABLE wipe_words (v TEXT NOT NULL)");
const addWord = db.prepare("INSERT INTO temp.wipe_words (v) VALUES (?)");
for (const word of new Set([...escapedToo(words), ...escapedToo(extraTexts)]))
  if (word !== conversation) addWord.run(word);
const holdsWord = (table, column) =>
  `EXISTS (SELECT 1 FROM temp.wipe_words w WHERE instr("${table}"."${column}", w.v) > 0)`;

// ---- Delete
const deleted = {};
// Columns of the chat's place and address cleared because they held a word.
const scrubbed = {};
function remove(table, column, values) {
  const list = [...values];
  if (!list.length || !has(table, column)) return;
  const sql = `DELETE FROM ${table} WHERE ${column} IN (${placeholders(list)})`;
  const changes = dryRun
    ? (all(
        `SELECT count(*) AS n FROM ${table} WHERE ${column} IN (${placeholders(list)})`,
        ...list,
      )[0].n ?? 0)
    : Number(db.prepare(sql).run(...list).changes);
  if (changes) deleted[table] = (deleted[table] ?? 0) + changes;
}

db.exec("BEGIN IMMEDIATE");
try {
  remove("slack_app_messages", "channel_id", [conversation]);
  if (chatIds.size && has("chat_messages", "id")) {
    const ids = [...chatIds];
    const messageIds = all(
      `SELECT id FROM chat_messages WHERE chat_id IN (${placeholders(ids)})`,
      ...ids,
    ).map((r) => r.id);
    remove("agent_turn_messages", "message_id", messageIds);
    remove("chat_messages", "chat_id", ids);
  }
  // The rows of a session, as WebchatRepository.deleteSessionRows lists them,
  // and the Concierge's per-message rows keyed by the session's chat id.
  for (const [table, column] of [
    ["agent_turn_messages", "session_id"],
    ["rome_agent_trace_blocks", "session_id"],
    ["rome_agent_messages", "session_id"],
    ["rome_agent_message_platform_ids", "session_id"],
    ["webchat_turn_feedback", "session_id"],
    ["chat_outputs", "session_id"],
    ["chat_output_backfills", "session_id"],
    ["webchat_workspace_layouts", "session_id"],
    ["shared_chats", "session_id"],
    ["concierge_message_turns", "chat_id"],
    ["concierge_message_tasks", "chat_id"],
    ["rome_sessions", "id"],
  ]) {
    remove(table, column, sessionIds);
  }
  remove("session_turn_checkpoints", "session_id", providerSessions.keys());
  remove("sessions", "id", providerSessions.keys());
  sweep();
  scrubPlaces();
  db.exec(dryRun ? "ROLLBACK" : "COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  fail(1, `wipe failed: ${error.message}`);
}

/**
 * Clears each nullable text column of the chat's place and address that holds
 * a word, such as a chat's title, and keeps the row with its key and address.
 */
function scrubPlaces() {
  for (const table of PLACES) {
    for (const column of schema.get(table) ?? []) {
      if (!isTextColumn(table, column) || !nullable(table, column)) continue;
      const where = holdsWord(table, column);
      const n = all(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`)[0].n;
      if (!n) continue;
      (scrubbed[table] ??= {})[column] = n;
      if (!dryRun) db.exec(`UPDATE "${table}" SET "${column}" = NULL WHERE ${where}`);
    }
  }
}

/**
 * Deletes, from every table but the chat's place and address, each row whose
 * text names the conversation or holds a wiped message. A row another row
 * still points at is retried once that one is gone.
 */
function sweep() {
  // Conversations whose rows the sweep takes: their provider sessions keep the
  // words in the model's context and transcript, so those go too.
  const touched = new Set();
  for (let pass = 0; pass < 5; pass++) {
    let progress = false;
    for (const [table, columns] of schema) {
      if (PLACES.has(table) || NEVER.has(table)) continue;
      const text = [...columns].filter((c) => isTextColumn(table, c));
      if (!text.length) continue;
      const where = holdsNeedle(table, text);
      const found = all(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`)[0].n;
      if (!found) continue;
      if (columns.has("session_id")) {
        for (const r of all(`SELECT DISTINCT session_id AS id FROM "${table}" WHERE ${where}`))
          if (r.id != null) touched.add(r.id);
      }
      if (table === "sessions" && columns.has("provider_thread_id")) {
        for (const r of all(`SELECT id, provider_thread_id AS thread FROM sessions WHERE ${where}`))
          providerSessions.set(r.id, r.thread);
      }
      if (dryRun) {
        if (pass === 0) deleted[table] = (deleted[table] ?? 0) + found;
        continue;
      }
      try {
        const changes = Number(db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run().changes);
        if (changes) {
          deleted[table] = (deleted[table] ?? 0) + changes;
          progress = true;
        }
      } catch (error) {
        if (!/FOREIGN KEY/i.test(error.message)) throw error;
      }
    }
    if (!progress) break;
  }
  const ids = [...touched].filter((id) => !sessionIds.has(id));
  if (!ids.length || !has("sessions", "chat_id")) return;
  const more = all(
    `SELECT id, provider_thread_id AS thread FROM sessions WHERE chat_id IN (${placeholders(ids)})`,
    ...ids,
  ).filter((r) => !providerSessions.has(r.id));
  for (const r of more) providerSessions.set(r.id, r.thread);
  remove(
    "session_turn_checkpoints",
    "session_id",
    more.map((r) => r.id),
  );
  remove(
    "sessions",
    "id",
    more.map((r) => r.id),
  );
}

// ---- Provider transcripts
const threads = new Set([...providerSessions.values()].filter(Boolean));
const transcripts = [];
for (const home of homes) walk(home, 0);
function walk(dir, depth) {
  if (depth > 7 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const path = join(dir, e.name);
    const stem = e.name.replace(/\.jsonl$/, "");
    if (threads.has(stem) && (e.isDirectory() || e.name.endsWith(".jsonl"))) {
      transcripts.push(path);
      if (!dryRun) rmSync(path, { recursive: true, force: true });
    } else if (e.isDirectory()) {
      walk(path, depth + 1);
    }
  }
}

// ---- Files holding a given text
// Only with --text: memory and other files under the homes lose each line that
// holds one of the texts. A transcript (.jsonl) that holds one goes whole, with
// its provider session, since a transcript missing lines cannot be resumed.
const FILES = "(files)";
const textNeedles = escapedToo(extraTexts);
const fileHits = (body) => textNeedles.filter((t) => body.includes(t)).length;
if (textNeedles.length) for (const home of homes) eachTextFile(home, sweepFile);
function sweepFile(path, body) {
  if (!fileHits(body)) return;
  if (path.endsWith(".jsonl")) {
    transcripts.push(path);
    const thread = path.replace(/^.*\//, "").replace(/\.jsonl$/, "");
    if (has("sessions", "provider_thread_id")) {
      const ids = all("SELECT id FROM sessions WHERE provider_thread_id = ?", thread).map(
        (r) => r.id,
      );
      for (const id of ids) providerSessions.set(id, thread);
      remove("session_turn_checkpoints", "session_id", ids);
      remove("sessions", "id", ids);
    }
    deleted[FILES] = (deleted[FILES] ?? 0) + 1;
    if (!dryRun) rmSync(path, { force: true });
    return;
  }
  const lines = body.split("\n");
  const keep = lines.filter((l) => !fileHits(l));
  deleted[FILES] = (deleted[FILES] ?? 0) + (lines.length - keep.length);
  if (dryRun) return;
  if (keep.join("").trim()) writeFileSync(path, keep.join("\n"));
  else rmSync(path, { force: true });
}

// ---- Look for anything left
// A dry run changed nothing, so it has nothing to check. The chat's place and
// address name the conversation and hold no message: they are reported as kept.
// Both count rows per column: a row whose two columns both hold a needle is
// counted under each, and `deleted` counts each row once, per table.
const remaining = {};
const kept = {};
for (const [table, columns] of dryRun ? [] : schema) {
  for (const column of columns) {
    if (!isTextColumn(table, column)) continue;
    const n = all(`SELECT count(*) AS n FROM "${table}" WHERE ${holdsNeedle(table, [column])}`)[0]
      .n;
    if (!n) continue;
    // A place or address that still holds a word, not only the conversation
    // id, keeps content: that is a remaining copy, not a kept name.
    const wordRows = PLACES.has(table)
      ? all(`SELECT count(*) AS n FROM "${table}" WHERE ${holdsWord(table, column)}`)[0].n
      : n;
    if (wordRows) (remaining[table] ??= {})[column] = wordRows;
    if (n > wordRows) (kept[table] ??= {})[column] = n - wordRows;
  }
}

if (textNeedles.length && !dryRun) {
  for (const home of homes)
    eachTextFile(home, (path, body) => {
      const n = fileHits(body);
      if (n) (remaining[FILES] ??= {})[path] = n;
    });
}

db.close();
if (!dryRun) keepOwner(dbPath);

const result = {
  ok: Object.keys(remaining).length === 0,
  dry_run: dryRun,
  db: dbPath,
  conversation,
  member,
  chats: [...chatIds],
  sessions: [...sessionIds],
  provider_sessions: [...providerSessions.keys()],
  deleted,
  scrubbed,
  transcripts,
  remaining,
  kept,
};
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 3);

// ---------------------------------------------------------------------------

function readSchema(database) {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name));
  const map = new Map();
  const notNull = new Map();
  for (const table of tables) {
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all();
    map.set(table, new Map(columns.map((c) => [c.name, String(c.type).toUpperCase()])));
    notNull.set(table, new Set(columns.filter((c) => c.notnull || c.pk).map((c) => c.name)));
  }
  // Callers use `.has(column)`; keep the type for the scan.
  return new Map(
    [...map].map(([table, columns]) => {
      const set = new Set(columns.keys());
      set.types = columns;
      set.notNull = notNull.get(table);
      return [table, set];
    }),
  );
}

/** Each word as it is, and as it reads inside a JSON string (quotes, newlines
 *  and backslashes escaped), since copies such as rome_agent_messages.content
 *  are kept as JSON. */
function escapedToo(list) {
  const out = new Set();
  for (const word of list) {
    out.add(word);
    out.add(JSON.stringify(word).slice(1, -1));
  }
  return [...out];
}

function nullable(table, column) {
  return !schema.get(table).notNull.has(column);
}

function isTextColumn(table, column) {
  const type = schema.get(table).types.get(column) ?? "";
  return /^[A-Za-z0-9_]+$/.test(column) && (type === "" || /TEXT|CHAR|CLOB|JSON/.test(type));
}

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

/** SQLite may leave -wal and -shm files behind; they must stay Rome's. */
function keepOwner(path) {
  const { uid, gid } = statSync(path);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      if (existsSync(path + suffix)) chownSync(path + suffix, uid, gid);
    } catch {
      // Not root: the files are already ours, which is Rome's.
    }
  }
}

/** Calls `fn(path, body)` for each text file under `dir` but the database's own. */
function eachTextFile(dir, fn, depth = 0) {
  if (depth > 9 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) eachTextFile(path, fn, depth + 1);
    if (!e.isFile() || path.startsWith(dbPath)) continue;
    let body;
    try {
      if (statSync(path).size > 8 * 1024 * 1024) continue;
      body = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!body.includes("\0")) fn(path, body);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      if (key === "text") (out.text ??= []).push(next);
      else out[key] = next;
      i++;
    }
  }
  return out;
}

function fail(code, message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}
