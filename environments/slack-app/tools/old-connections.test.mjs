// Runs old-connections.mjs prepare against the fake Slack and write against a
// database built from Rome's own migrations. ROME_SRC names the rome checkout
// whose migrations and connection kinds to use; without it, this checkout's.
// Run: node --test environments/slack-app/tools/old-connections.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, start } from "../fake-slack/server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const romeSrc = process.env.ROME_SRC ?? join(here, "../../..");
const tool = join(here, "old-connections.mjs");
const B = "TB0000BBBB";
const GUARDIAN = "UB0000GUARD";
let fake;
let base;

before(async () => {
  fake = start(
    loadConfig({
      port: 0,
      workspacesFile: join(here, "../config/workspaces.json"),
      signingSecret: "s",
      clientSecret: "c",
      clientId: "111.222",
      eventsUrl: "http://127.0.0.1:9/events",
      retryDelaysMs: "",
    }),
  );
  await new Promise((r) => fake.servers[0].once("listening", r));
  base = `http://127.0.0.1:${fake.servers[0].address().port}`;
});
after(() => {
  for (const s of fake.servers) s.close();
});

function migrate(path) {
  const dir = join(romeSrc, "packages/core/drizzle/system");
  const db = new DatabaseSync(path);
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    for (const s of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint")) {
      if (s.trim()) db.exec(s);
    }
  }
  return db;
}

/** The keys a connection kind's strict profile schema takes, from rome's source. */
function schemaKeys(file, name) {
  const src = readFileSync(
    join(romeSrc, "packages/core/src/connections/integrations", file),
    "utf8",
  );
  const at = src.indexOf(`${name} = z`);
  assert.ok(at >= 0, `${name} in ${file}`);
  const body = src.slice(at, src.indexOf(".strict()", at));
  return new Set([...body.matchAll(/^\s+(\w+): /gm)].map((m) => m[1]));
}

const node = (args, input) =>
  execFileSync(process.execPath, [tool, ...args], { input, encoding: "utf8" }).trim();

test("prepare reads each old app the way rome did, and write leaves the rows an upgrade finds", async () => {
  const spec = JSON.parse(await runAsync(["prepare", base, B, GUARDIAN]));
  const bot = spec.slack_bot;
  const oauth = spec.slack;

  // The bot's profile is what setup kept: auth.test's workspace and bot, and
  // the app bots.info names.
  assert.deepEqual(bot.profile, {
    teamId: B,
    botUserId: bot.bot_user_id,
    workspaceName: "Bayside",
    botUsername: "rome-bot",
    appId: bot.app_id,
  });
  assert.equal(bot.account_id, `${B}/${bot.bot_user_id}`);
  assert.match(bot.material.botToken, /^xoxb-/);
  assert.match(bot.material.appToken, /^xapp-/);
  // Rome Cloud's OAuth profile names the installer by workspace and member.
  assert.equal(oauth.profile.subject, `${B}:${GUARDIAN}`);
  assert.equal(oauth.profile.teamId, B);
  assert.equal(oauth.profile.email, "dana@bayside.test");
  assert.ok(oauth.profile.scopes.includes("users:read.email"));
  assert.match(oauth.material.userToken, /^xoxp-/);
  // Each profile passes its kind's strict schema: no key it does not know.
  for (const [profile, file, name] of [
    [bot.profile, "slack-bot.ts", "slackBotGrantProfileSchema"],
    [oauth.profile, "oauth-providers.ts", "slackGrantProfileSchema"],
  ]) {
    const keys = schemaKeys(file, name);
    for (const k of Object.keys(profile)) assert.ok(keys.has(k), `${name} takes ${k}`);
  }

  const dbPath = join(mkdtempSync(join(tmpdir(), "old-conn-")), "rome.db");
  migrate(dbPath).close();
  const first = JSON.parse(node(["write", "--db", dbPath], JSON.stringify(spec)));
  assert.equal(first.ok, true);
  assert.equal(first.slack_bot.written, true);
  assert.equal(first.slack.written, true);
  assert.ok(!JSON.stringify(first).includes(bot.material.botToken));

  const db = new DatabaseSync(dbPath);
  const conns = db.prepare("SELECT * FROM connections ORDER BY connection_kind").all();
  assert.deepEqual(
    conns.map((c) => [c.connection_kind, c.label]),
    [
      ["slack", "slack"],
      ["slack_bot", "slack_bot"],
    ],
  );
  const grant = (kind) =>
    db
      .prepare(
        "SELECT g.* FROM connection_grants g JOIN connections c ON c.id = g.custody WHERE c.connection_kind = ?",
      )
      .get(kind);
  for (const [kind, s] of [
    ["slack_bot", bot],
    ["slack", oauth],
  ]) {
    const g = grant(kind);
    assert.equal(g.state, "authorized");
    assert.equal(g.platform, "slack");
    assert.equal(g.account_id, s.account_id);
    assert.deepEqual(JSON.parse(g.credential), {
      material: { kind: "inline", record: s.material },
      expiresAt: "never",
    });
    assert.deepEqual(JSON.parse(g.profile), s.profile);
    assert.match(g.grant_epoch, /^[0-9a-f-]{36}$/);
  }
  // The bot talks, so it has its channel and its account, with no agent yet.
  const channel = db.prepare("SELECT * FROM channels WHERE connection_kind = 'slack_bot'").get();
  assert.equal(channel.connection_id, first.slack_bot.connection_id);
  assert.equal(channel.platform_account_id, bot.account_id);
  assert.notEqual(channel.id, "slack_bot");
  assert.deepEqual(
    db
      .prepare("SELECT platform, account_id, agent FROM connected_accounts")
      .all()
      .map((r) => ({ ...r })),
    [{ platform: "slack", account_id: bot.account_id, agent: null }],
  );
  assert.equal(
    db.prepare("SELECT display_name FROM account_profiles WHERE account_id = ?").get(bot.account_id)
      .display_name,
    "rome-bot (Bayside)",
  );
  // The OAuth kind does not talk: no channel of its own.
  assert.equal(
    db.prepare("SELECT count(*) n FROM channels WHERE connection_kind = 'slack'").get().n,
    0,
  );
  db.close();

  // Again: each kind keeps the connection it has.
  const again = JSON.parse(node(["write", "--db", dbPath], JSON.stringify(spec)));
  assert.equal(again.slack_bot.written, false);
  assert.equal(again.slack_bot.connection_id, first.slack_bot.connection_id);
  assert.equal(new DatabaseSync(dbPath).prepare("SELECT count(*) n FROM connections").get().n, 2);
});

// prepare talks to the fake, which runs in this process, so it cannot block it.
function runAsync(args) {
  return new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) =>
      execFile(process.execPath, [tool, ...args], (err, out) => (err ? reject(err) : resolve(out))),
    );
  });
}
