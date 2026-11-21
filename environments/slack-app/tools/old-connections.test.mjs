// Runs old-connections.mjs write against the fake Slack and a database built
// from Rome's own migrations. ROME_SRC names the rome checkout
// whose migrations and connection kinds to use; without it, this checkout's.
// Run: node --test environments/slack-app/tools/old-connections.test.mjs
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

/** The keys a connection kind's strict profile schema takes, from rome's
 *  source, or null on a Rome that no longer has the kind. */
function schemaKeys(file, name) {
  const path = join(romeSrc, "packages/core/src/connections/integrations", file);
  if (!existsSync(path)) return null;
  const src = readFileSync(path, "utf8");
  const at = src.indexOf(`${name} = z`);
  if (at < 0) return null;
  const body = src.slice(at, src.indexOf(".strict()", at));
  return new Set([...body.matchAll(/^\s+(\w+): /gm)].map((m) => m[1]));
}

const write = (dbPath) =>
  runAsync(["write", "--fake", base, "--team", B, "--guardian", GUARDIAN, "--db", dbPath]);

/** The app's tokens, as the fake hands them to setup: the same name answers the same app. */
async function tokensOf(kind, name) {
  const r = await fetch(`${base}/_control/other-app`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ team: B, kind, name }),
  });
  const a = await r.json();
  return {
    app_id: a.app_id,
    bot_user_id: a.bot_user_id,
    bot: a.bot_token,
    app: a.app_token,
    user: a.user_token,
  };
}

test("write reads each old app the way rome did, and leaves the rows an upgrade finds", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "old-conn-")), "rome.db");
  migrate(dbPath).close();
  const first = JSON.parse(await write(dbPath));
  assert.equal(first.ok, true);
  assert.equal(first.slack_bot.written, true);
  assert.equal(first.slack.written, true);

  const botApp = await tokensOf("socket_bot", "Rome Bot");
  const oauthApp = await tokensOf("oauth", "Rome");
  assert.ok(!JSON.stringify(first).includes(botApp.bot));
  assert.ok(!JSON.stringify(first).includes(oauthApp.user));
  const profileOf = (kind) =>
    JSON.parse(
      new DatabaseSync(dbPath)
        .prepare(
          "SELECT g.profile FROM connection_grants g JOIN connections c ON c.id = g.custody WHERE c.connection_kind = ?",
        )
        .get(kind).profile,
    );
  const bot = {
    ...first.slack_bot,
    material: { botToken: botApp.bot, appToken: botApp.app },
    profile: profileOf("slack_bot"),
  };
  const oauth = {
    ...first.slack,
    material: { botToken: oauthApp.bot, userToken: oauthApp.user },
    profile: profileOf("slack"),
  };

  // The bot's profile is what setup kept: auth.test's workspace and bot, and
  // the app bots.info names.
  assert.deepEqual(bot.profile, {
    teamId: B,
    botUserId: botApp.bot_user_id,
    workspaceName: "Bayside",
    botUsername: "rome-bot",
    appId: botApp.app_id,
  });
  assert.equal(bot.account_id, `${B}/${botApp.bot_user_id}`);
  assert.match(bot.material.botToken, /^xoxb-/);
  assert.match(bot.material.appToken, /^xapp-/);
  // Rome Cloud's OAuth profile names the installer by workspace and member.
  assert.equal(oauth.profile.subject, `${B}:${GUARDIAN}`);
  assert.equal(oauth.account_id, `${B}:${GUARDIAN}`);
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
    // A Rome without the kind keeps no schema to hold the profile to: the
    // rows stay as the last Rome that knew it wrote them.
    if (!keys) continue;
    for (const k of Object.keys(profile)) assert.ok(keys.has(k), `${name} takes ${k}`);
  }

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
  const again = JSON.parse(await write(dbPath));
  assert.equal(again.slack_bot.written, false);
  assert.equal(again.slack_bot.connection_id, first.slack_bot.connection_id);
  assert.equal(new DatabaseSync(dbPath).prepare("SELECT count(*) n FROM connections").get().n, 2);

  // old-rows: each kind's connection and grant rows, still stored, and no content.
  const ids = JSON.stringify({
    slack_bot: first.slack_bot.connection_id,
    slack: first.slack.connection_id,
  });
  const rows = () =>
    JSON.parse(
      execFileSync(process.execPath, [join(here, "old-rows.mjs"), "--db", dbPath, "--ids", ids], {
        encoding: "utf8",
      }),
    );
  assert.deepEqual(rows(), {
    slack_bot: { connection_id: first.slack_bot.connection_id, stored: true },
    slack: { connection_id: first.slack.connection_id, stored: true },
  });
  // A connection without its grant is not stored.
  const edit = new DatabaseSync(dbPath);
  edit.prepare("DELETE FROM connection_grants WHERE custody = ?").run(first.slack.connection_id);
  edit.close();
  assert.equal(rows().slack.stored, false);
  assert.equal(rows().slack_bot.stored, true);
});

test("check counts only a Socket Mode connection open now, not one that said hello and closed", async () => {
  const bot = await tokensOf("socket_bot", "Rome Bot");
  const cloud = await tokensOf("oauth", "Rome");
  // A stand-in for the instance's connections route: only GET exists.
  let botAgent = "core:main";
  let listedIds = ["c-bot", "c-cloud"];
  const instance = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET") {
      res.statusCode = 404;
      return res.end("{}");
    }
    const all = [{ id: "c-bot", agent: botAgent }, { id: "c-cloud" }];
    res.end(JSON.stringify({ connections: all.filter((c) => listedIds.includes(c.id)) }));
  }).listen(0);
  await new Promise((r) => instance.once("listening", r));
  const dir = mkdtempSync(join(tmpdir(), "old-check-"));
  const cloudState = (await (await fetch(`${base}/_control/state`)).json()).other_apps.find(
    (a) => a.app_id === cloud.app_id,
  );
  const cloudTails = {
    bot_token_tail: cloudState.bot_token_tail,
    user_token_tail: cloudState.user_token_tail,
  };
  const file = (name, value) => {
    writeFileSync(join(dir, name), JSON.stringify(value));
    return join(dir, name);
  };
  const args = [
    "check",
    `http://127.0.0.1:${instance.address().port}`,
    file("cookies.json", { s: "1" }),
    base,
    file("written.json", {
      slack_bot: {
        connection_id: "c-bot",
        account_id: `${B}/${bot.bot_user_id}`,
        app_id: bot.app_id,
      },
      slack: { connection_id: "c-cloud", account_id: `${B}:${GUARDIAN}`, app_id: cloud.app_id },
    }),
    file("token-file.json", { exists: true, ...cloudTails }),
  ];
  const opened = await (
    await fetch(`${base}/api/apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${bot.app}` },
    })
  ).json();
  const url = new URL(opened.url);
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}${url.pathname}${url.search}`);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    return ws;
  };
  try {
    const ws = await connect();
    for (let i = 0; i < 50; i++) {
      const { sockets } = await (await fetch(`${base}/_control/sockets`)).json();
      if (sockets.some((x) => x.appId === bot.app_id && x.event === "hello")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    ws.close();
    for (let i = 0; i < 50; i++) {
      const { open_sockets } = await (await fetch(`${base}/_control/state`)).json();
      if (!open_sockets.length) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // Shorten check's wait: the fake has no open connection, which check
    // reports without failing, as a Rome that ignores the rows leaves it.
    const closed = JSON.parse(await runAsync(args, { OLD_CONNECTIONS_WAIT_S: "1" }));
    assert.equal(closed.checks.bot_socket_open, false);
    const again = await (
      await fetch(`${base}/api/apps.connections.open`, {
        method: "POST",
        headers: { authorization: `Bearer ${bot.app}` },
      })
    ).json();
    url.search = new URL(again.url).search;
    const live = await connect();
    const passed = JSON.parse(await runAsync(args, { OLD_CONNECTIONS_WAIT_S: "1" }));
    assert.equal(passed.checks.bot_socket_open, true);
    assert.equal(passed.checks.oauth_token_file, true);
    // A token file with the bot token but no user token is not the OAuth app's.
    file("token-file.json", { exists: true, bot_token_tail: cloudTails.bot_token_tail });
    const noUser = JSON.parse(await runAsync(args, { OLD_CONNECTIONS_WAIT_S: "1" }));
    assert.equal(noUser.checks.oauth_token_file, false);
    file("token-file.json", { exists: true, ...cloudTails });
    // The bot's agent comes from the connections list, with no route that sets one.
    assert.equal(passed.checks.bot_agent, "core:main");
    // A Rome that no longer knows the kinds lists neither connection.
    botAgent = null;
    listedIds = [];
    const ignored = JSON.parse(await runAsync(args, { OLD_CONNECTIONS_WAIT_S: "1" }));
    assert.equal(ignored.checks.bot_agent, null);
    assert.equal(ignored.checks.bot_listed, false);
    assert.equal(ignored.checks.oauth_listed, false);
    live.close();
  } finally {
    instance.close();
  }
});

// write and check talk to the fake, which runs in this process, so they cannot block it.
function runAsync(args, env = {}) {
  return new Promise((resolve, reject) =>
    execFile(process.execPath, [tool, ...args], { env: { ...process.env, ...env } }, (err, out) =>
      err ? reject(Object.assign(err, { stdout: out })) : resolve(out),
    ),
  );
}
