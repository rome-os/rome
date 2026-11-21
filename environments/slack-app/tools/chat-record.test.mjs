// Run: ROME_SRC=<rome checkout> node --test environments/slack-app/tools/chat-record.test.mjs
// The database is built from Rome's own migrations under ROME_SRC (this
// checkout by default).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const romeSrc = process.env.ROME_SRC ?? join(here, "../../..");
const tool = join(here, "chat-record.mjs");

function migrated() {
  const path = join(mkdtempSync(join(tmpdir(), "chat-record-")), "rome.db");
  const db = new DatabaseSync(path);
  const dir = join(romeSrc, "packages/core/drizzle/system");
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    for (const s of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint"))
      if (s.trim()) db.exec(s);
  }
  return { db, path };
}

test("record lists a conversation's messages as Chats keeps them, and its threads", () => {
  const { db, path } = migrated();
  const say = (chat, key, text, at, thread = null) =>
    db
      .prepare(
        "INSERT INTO chat_messages (chat_id, key, thread_id, text, parts, said_at) VALUES (?, ?, ?, ?, '[]', ?)",
      )
      .run(chat, key, thread, text, at);
  // A direct message reached by its address, and a group keyed by its id.
  const dm = db
    .prepare("INSERT INTO chats (platform, key, kind, started_at) VALUES ('slack_app', ?, 'dm', 1)")
    .run("dm:UBOT:UA0000BOB01").lastInsertRowid;
  db.prepare(
    "INSERT INTO chat_addresses (platform, account_id, chat_key, address) VALUES ('slack_app', 'UBOT', ?, 'DA000BOB01')",
  ).run("dm:UBOT:UA0000BOB01");
  const group = db
    .prepare(
      "INSERT INTO chats (platform, key, kind, started_at) VALUES ('slack_app', 'CA0000NEWS', 'group', 1)",
    )
    .run().lastInsertRowid;
  say(dm, "1700000002.000100", "second", 1700000002);
  say(dm, "1700000001.000100", "first", 1700000001);
  say(group, "1700000003.000100", "Who brings lanterns?", 1700000003);
  say(group, "1700000004.000100", "Six paper lanterns.", 1700000004, "1700000003.000100");
  say(group, "1700000005.000100", "Not in the thread.", 1700000005);
  db.close();
  const before = readFileSync(path);

  const run = (...args) =>
    JSON.parse(execFileSync(process.execPath, [tool, "--db", path, ...args]));
  const direct = run("--chat", "DA000BOB01");
  assert.deepEqual(direct.chats, [Number(dm)]);
  assert.deepEqual(direct.messages, [
    { key: "1700000001.000100", text: "first", at: "2023-11-14T22:13:21.000Z" },
    { key: "1700000002.000100", text: "second", at: "2023-11-14T22:13:22.000Z" },
  ]);
  // Found by the member's direct message key as well.
  assert.deepEqual(run("--chat", "DXNOADDRESS", "--member", "UA0000BOB01").chats, [Number(dm)]);

  assert.equal(run("--chat", "CA0000NEWS").messages.length, 3);
  const thread = run("--chat", "CA0000NEWS:1700000003.000100").messages;
  assert.deepEqual(
    thread.map((m) => [m.key, m.thread]),
    [
      ["1700000003.000100", undefined],
      ["1700000004.000100", "1700000003.000100"],
    ],
  );
  assert.deepEqual(run("--chat", "CNOTHERE").messages, []);
  // Read only: the database is unchanged.
  assert.deepEqual(readFileSync(path), before);

  // Piped in, as ctl.sh runs it inside the instance.
  const piped = JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "-", "--db", path, "--chat", "DA000BOB01"],
      { input: readFileSync(tool) },
    ),
  );
  assert.equal(piped.messages.length, 2);
});
