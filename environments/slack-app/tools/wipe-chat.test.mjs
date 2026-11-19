// Runs wipe-chat.mjs against a database built from Rome's own migrations.
// ROME_SRC names the rome checkout whose migrations to use (env.json's
// repos.rome); without it, this checkout's.
// Run: node --test environments/slack-app/tools/wipe-chat.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const romeSrc = process.env.ROME_SRC ?? join(here, "../../..");
const migrations = join(romeSrc, "packages/core/drizzle/system");
const DM = "DA000BOB01";
const OTHER = "DA000CARA1";

function migrate(path) {
  const db = new DatabaseSync(path);
  const files = readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    for (const statement of readFileSync(join(migrations, f), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) db.exec(statement);
    }
  }
  return db;
}

/** Inserts `values`, filling every other NOT NULL column without a default. */
function insert(db, table, values) {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
  if (!columns.length) return false;
  const row = { ...values };
  for (const c of columns) {
    if (c.name in row || !c.notnull || c.dflt_value !== null || c.pk === 1) continue;
    row[c.name] = /INT|REAL/i.test(c.type) ? 1 : "x";
  }
  const names = Object.keys(row).filter((n) => columns.some((c) => c.name === n));
  db.prepare(
    `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
  ).run(...names.map((n) => (typeof row[n] === "object" ? JSON.stringify(row[n]) : row[n])));
  return true;
}

function seedChat(db, { conversation, member, words, session, thread }) {
  const hasSlackCopy = insert(db, "slack_app_messages", {
    team_id: "TA0000AAAA",
    event_id: `Ev${conversation}`,
    channel_id: conversation,
    ts: "1.000001",
    user_id: member,
    text: words,
    said_at: 1,
    message: { text: words },
    received_at: 1,
  });
  const chat = db
    .prepare("INSERT INTO chats (platform, key, kind, started_at) VALUES (?, ?, ?, 1)")
    .run("slack_app", `dm:UBOTA0000AAAA:${member}`, "dm").lastInsertRowid;
  insert(db, "chat_addresses", {
    platform: "slack_app",
    account_id: "UBOTA0000AAAA",
    chat_key: `dm:UBOTA0000AAAA:${member}`,
    address: conversation,
  });
  const message = db
    .prepare(
      "INSERT INTO chat_messages (chat_id, key, text, parts, said_at) VALUES (?, '1.000001', ?, '[]', 1)",
    )
    .run(chat, words).lastInsertRowid;
  insert(db, "rome_sessions", {
    id: session,
    name: "Slack",
    type: "channel",
    source_channel: "slack_app",
    source_thread_id: conversation,
    chat_id: chat,
    created_at: 1,
    activity_at: 1,
  });
  insert(db, "agent_turn_messages", { message_id: message, session_id: session, role: "prompt" });
  insert(db, "rome_agent_messages", {
    id: `m-${session}`,
    session_id: session,
    role: "user",
    content: [{ type: "text", text: words }],
    created_at: 1,
  });
  insert(db, "rome_agent_messages", {
    id: `t-${session}`,
    session_id: session,
    role: "trace",
    content: "[]",
    created_at: 1,
  });
  insert(db, "rome_agent_trace_blocks", {
    message_id: `t-${session}`,
    seq: 0,
    session_id: session,
    content: { type: "text", text: `The agent read: ${words}` },
  });
  insert(db, "sessions", {
    id: `p-${session}`,
    agent_name: "concierge",
    chat_id: session,
    provider: "claude",
    provider_thread_id: thread,
    created_at: 1,
    last_active_at: 1,
    status: "active",
  });
  return { hasSlackCopy, chat };
}

test("wipes one chat's messages, its sessions and transcripts, and nothing else", () => {
  assert.ok(existsSync(migrations), `no migrations at ${migrations}`);
  const dir = mkdtempSync(join(tmpdir(), "wipe-chat-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".rome/default"), { recursive: true });
  const projects = join(home, ".claude/projects/-home-rome");
  mkdirSync(projects, { recursive: true });
  const dbPath = join(home, ".rome/default/rome.db");
  const db = migrate(dbPath);
  const wiped = seedChat(db, {
    conversation: DM,
    member: "UA0000BOB01",
    words: "Bob's locker code is 4417",
    session: `channel:slack_app:${DM}`,
    thread: "11111111-aaaa",
  });
  seedChat(db, {
    conversation: OTHER,
    member: "UA0000CARA1",
    words: "Cara likes green tea",
    session: `channel:slack_app:${OTHER}`,
    thread: "22222222-bbbb",
  });
  db.close();
  writeFileSync(join(projects, "11111111-aaaa.jsonl"), "{}\n");
  writeFileSync(join(projects, "22222222-bbbb.jsonl"), "{}\n");

  const run = (...extra) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(here, "wipe-chat.mjs"),
          "--conversation",
          DM,
          "--member",
          "UA0000BOB01",
          "--homes",
          home,
          ...extra,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ),
    );

  const dry = run("--dry-run");
  assert.equal(dry.dry_run, true);
  assert.equal(dry.transcripts.length, 1);
  assert.ok(existsSync(join(projects, "11111111-aaaa.jsonl")));

  const result = run();
  assert.equal(result.ok, true, JSON.stringify(result.remaining));
  assert.equal(result.db, dbPath);
  assert.deepEqual(result.chats, [Number(wiped.chat)]);
  assert.deepEqual(result.sessions, [`channel:slack_app:${DM}`]);
  assert.equal(result.deleted.chat_messages, 1);
  assert.equal(result.deleted.rome_agent_messages, 2);
  assert.equal(result.deleted.rome_agent_trace_blocks, 1);
  assert.equal(result.deleted.sessions, 1);
  if (wiped.hasSlackCopy) assert.equal(result.deleted.slack_app_messages, 1);
  assert.ok(!existsSync(join(projects, "11111111-aaaa.jsonl")));
  assert.ok(existsSync(join(projects, "22222222-bbbb.jsonl")));

  const after = new DatabaseSync(dbPath);
  const count = (sql, ...p) => after.prepare(sql).get(...p).n;
  assert.equal(count("SELECT count(*) AS n FROM chat_messages WHERE text LIKE '%4417%'"), 0);
  assert.equal(count("SELECT count(*) AS n FROM chat_messages WHERE text LIKE '%green tea%'"), 1);
  assert.equal(
    count("SELECT count(*) AS n FROM rome_sessions WHERE id = ?", `channel:slack_app:${OTHER}`),
    1,
  );
  // The chat's place stays, so the next message lands in the same chat.
  assert.equal(count("SELECT count(*) AS n FROM chats"), 2);
  after.close();
});

for (const words of ["Bob's locker code is 4417", 'Bob\'s locker code is "4417"\nsee \\ above']) {
  test(`a copy left anywhere else fails the wipe: ${JSON.stringify(words)}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "wipe-chat-"));
    const home = join(dir, "home");
    mkdirSync(join(home, ".rome/default"), { recursive: true });
    const db = migrate(join(home, ".rome/default/rome.db"));
    seedChat(db, {
      conversation: DM,
      member: "UA0000BOB01",
      words,
      session: `channel:slack_app:${DM}`,
      thread: "33333333-cccc",
    });
    // The same words quoted in the guardian's dashboard chat.
    insert(db, "rome_agent_messages", {
      id: "elsewhere",
      session_id: "dashboard-chat",
      role: "user",
      content: [{ type: "text", text: words }],
      created_at: 1,
    });
    db.close();
    let out;
    try {
      execFileSync(
        process.execPath,
        [
          join(here, "wipe-chat.mjs"),
          "--conversation",
          DM,
          "--member",
          "UA0000BOB01",
          "--homes",
          home,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      assert.fail("expected exit 3");
    } catch (error) {
      assert.equal(error.status, 3);
      out = JSON.parse(error.stdout);
    }
    assert.equal(out.ok, false);
    assert.equal(out.remaining.rome_agent_messages.content, 1);
  });
}
