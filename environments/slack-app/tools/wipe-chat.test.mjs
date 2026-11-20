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
  test(`copies left anywhere else are swept, and the wipe exits 0: ${JSON.stringify(words)}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "wipe-chat-"));
    const home = join(dir, "home");
    mkdirSync(join(home, ".rome/default"), { recursive: true });
    const dbPath = join(home, ".rome/default/rome.db");
    const db = migrate(dbPath);
    seedChat(db, {
      conversation: DM,
      member: "UA0000BOB01",
      words,
      session: `channel:slack_app:${DM}`,
      thread: "33333333-cccc",
    });
    seedChat(db, {
      conversation: OTHER,
      member: "UA0000CARA1",
      words: "Cara likes green tea",
      session: `channel:slack_app:${OTHER}`,
      thread: "44444444-dddd",
    });
    // The same words quoted in the guardian's dashboard chat.
    insert(db, "rome_agent_messages", {
      id: "elsewhere",
      session_id: "dashboard-chat",
      role: "user",
      content: [{ type: "text", text: words }],
      created_at: 1,
    });
    insert(db, "rome_agent_messages", {
      id: "unrelated",
      session_id: "dashboard-chat",
      role: "user",
      content: [{ type: "text", text: "Cara likes green tea" }],
      created_at: 1,
    });
    // The dashboard chat's model thread read the words too.
    insert(db, "sessions", {
      id: "p-dashboard",
      agent_name: "concierge",
      chat_id: "dashboard-chat",
      provider: "claude",
      provider_thread_id: "66666666-ffff",
      created_at: 1,
      last_active_at: 1,
      status: "active",
    });
    // An action the agent ran with the words, and its approval.
    const args = { channel: DM, text: words };
    const seeded = {
      approvals: insert(db, "approvals", {
        id: "ap1",
        payload: args,
        status: "pending",
        created_at: 1,
      }),
      action_executions: insert(db, "action_executions", { id: "ax1", args, created_at: 1 }),
      execution_journal: insert(db, "execution_journal", { id: "ej1", args, created_at: 1 }),
      // A later table of the Slack app connection, found by what it holds.
      slack_app_timeline: insert(db, "slack_app_timeline", {
        team_id: "TA0000AAAA",
        channel_id: DM,
        ts: "1.000002",
        said_at: 1,
        message: { text: words },
      }),
    };
    db.close();
    const projects = join(home, ".claude/projects/-home-rome");
    mkdirSync(projects, { recursive: true });
    for (const thread of ["33333333-cccc", "44444444-dddd", "66666666-ffff"])
      writeFileSync(join(projects, `${thread}.jsonl`), "{}\n");

    const out = JSON.parse(
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
      ),
    );
    assert.equal(out.ok, true, JSON.stringify(out.remaining));
    assert.deepEqual(out.remaining, {});
    assert.ok(out.kept.chat_addresses, JSON.stringify(out.kept));
    assert.equal(out.deleted.rome_agent_messages, 3);
    for (const [table, present] of Object.entries(seeded)) {
      if (present) assert.ok(out.deleted[table] >= 1, `${table}: ${JSON.stringify(out.deleted)}`);
    }

    const after = new DatabaseSync(dbPath);
    const count = (sql, ...p) => after.prepare(sql).get(...p).n;
    assert.equal(count("SELECT count(*) AS n FROM rome_agent_messages WHERE id = 'unrelated'"), 1);
    assert.equal(count("SELECT count(*) AS n FROM chat_messages WHERE text LIKE '%green tea%'"), 1);
    assert.equal(count("SELECT count(*) AS n FROM chat_addresses WHERE address = ?", DM), 1);
    assert.equal(count("SELECT count(*) AS n FROM sessions WHERE id = 'p-dashboard'"), 0);
    assert.equal(
      count("SELECT count(*) AS n FROM sessions WHERE chat_id = ?", `channel:slack_app:${OTHER}`),
      1,
    );
    assert.ok(out.provider_sessions.includes("p-dashboard"), JSON.stringify(out.provider_sessions));
    assert.ok(!existsSync(join(projects, "66666666-ffff.jsonl")));
    assert.ok(!existsSync(join(projects, "33333333-cccc.jsonl")));
    assert.ok(existsSync(join(projects, "44444444-dddd.jsonl")));
    after.close();
  });
}

test("a long history is wiped in one pass, with a copy of each message elsewhere", () => {
  const dir = mkdtempSync(join(tmpdir(), "wipe-chat-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".rome/default"), { recursive: true });
  const dbPath = join(home, ".rome/default/rome.db");
  const db = migrate(dbPath);
  const { chat } = seedChat(db, {
    conversation: DM,
    member: "UA0000BOB01",
    words: "Bob's locker code is 4417",
    session: `channel:slack_app:${DM}`,
    thread: "55555555-eeee",
  });
  const said = Array.from({ length: 1500 }, (_, i) => `Bob said message number ${i}`);
  const addMessage = db.prepare(
    "INSERT INTO chat_messages (chat_id, key, text, parts, said_at) VALUES (?, ?, ?, '[]', 1)",
  );
  said.forEach((text, i) => {
    addMessage.run(chat, `2.${String(i).padStart(6, "0")}`, text);
    insert(db, "rome_agent_messages", {
      id: `copy-${i}`,
      session_id: "dashboard-chat",
      role: "user",
      content: [{ type: "text", text }],
      created_at: 1,
    });
  });
  db.close();

  const out = JSON.parse(
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
    ),
  );
  assert.equal(out.ok, true, JSON.stringify(out.remaining));
  assert.equal(out.deleted.chat_messages, said.length + 1);
  assert.equal(out.deleted.rome_agent_messages, said.length + 2);
});

test("--text removes what Rome distilled: rows and memory lines that hold the text", () => {
  const dir = mkdtempSync(join(tmpdir(), "wipe-chat-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".rome/default"), { recursive: true });
  const dbPath = join(home, ".rome/default/rome.db");
  const db = migrate(dbPath);
  seedChat(db, {
    conversation: DM,
    member: "UA0000BOB01",
    words: "Bob's locker code is 4417",
    session: `channel:slack_app:${DM}`,
    thread: "77777777-aaaa",
  });
  const fact = "locker 4417 by the east door";
  // Rome's restatement of the fact in another conversation, and in its memory.
  insert(db, "rome_agent_messages", {
    id: "distilled",
    session_id: "dashboard-chat",
    role: "assistant",
    content: [{ type: "text", text: `Noted: Bob's ${fact}.` }],
    created_at: 1,
  });
  insert(db, "rome_agent_messages", {
    id: "unrelated",
    session_id: "dashboard-chat",
    role: "user",
    content: [{ type: "text", text: "Cara likes green tea" }],
    created_at: 1,
  });
  insert(db, "sessions", {
    id: "p-memory",
    agent_name: "concierge",
    chat_id: "memory-chat",
    provider: "claude",
    provider_thread_id: "88888888-bbbb",
    created_at: 1,
    last_active_at: 1,
    status: "active",
  });
  // Another chat whose title holds the fact: the title goes, the chat stays.
  db.prepare(
    "INSERT INTO chats (platform, key, kind, name, started_at) VALUES ('webchat', 'titled', 'dm', ?, 1)",
  ).run(`About ${fact}`);
  db.close();
  const memory = join(home, ".rome/default/profile/memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "people.md"), `# People\n- Bob: ${fact}\n- Cara likes green tea\n`);
  writeFileSync(join(memory, "bob.md"), `- ${fact}\n`);
  const projects = join(home, ".claude/projects/-home-rome");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, "88888888-bbbb.jsonl"), `${JSON.stringify({ text: fact })}\n`);
  writeFileSync(join(projects, "99999999-cccc.jsonl"), "{}\n");

  const run = (...extra) =>
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
    );

  assert.throws(
    () => run("--text", "4417"),
    (e) => e.status === 2,
  );
  const dry = JSON.parse(run("--text", fact, "--text", "east door, by the lockers", "--dry-run"));
  assert.equal(dry.deleted["(files)"], 3);
  assert.ok(readFileSync(join(memory, "people.md"), "utf8").includes(fact));

  const out = JSON.parse(run("--text", fact, "--text", "east door, by the lockers"));
  assert.equal(out.ok, true, JSON.stringify(out.remaining));
  assert.deepEqual(out.remaining, {});
  assert.equal(out.deleted["(files)"], 3);
  assert.ok(out.provider_sessions.includes("p-memory"));
  assert.equal(
    readFileSync(join(memory, "people.md"), "utf8"),
    "# People\n- Cara likes green tea\n",
  );
  assert.ok(!existsSync(join(memory, "bob.md")));
  assert.ok(!existsSync(join(projects, "88888888-bbbb.jsonl")));
  assert.ok(existsSync(join(projects, "99999999-cccc.jsonl")));

  const after = new DatabaseSync(dbPath);
  const count = (sql) => after.prepare(sql).get().n;
  assert.equal(count("SELECT count(*) AS n FROM rome_agent_messages WHERE id = 'distilled'"), 0);
  assert.equal(count("SELECT count(*) AS n FROM rome_agent_messages WHERE id = 'unrelated'"), 1);
  assert.equal(count("SELECT count(*) AS n FROM sessions WHERE id = 'p-memory'"), 0);
  assert.deepEqual(out.scrubbed, { chats: { name: 1 } });
  assert.equal(after.prepare("SELECT name FROM chats WHERE key = 'titled'").get().name, null);
  after.close();
});
