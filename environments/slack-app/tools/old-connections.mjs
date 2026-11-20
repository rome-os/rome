// The two older Slack connections an upgraded instance holds (R10): a
// guardian's own Socket Mode bot (`slack_bot`) and Rome Cloud's earlier OAuth
// app (`slack`). Setup only: the rows are written into the instance's
// database while it is stopped, never through a product route.
//
//   node old-connections.mjs write --fake <fake-slack url> --team <team> --guardian <member> [--db path]
//     Installs both apps in the fake Slack, reads each identity the way the
//     product did when it connected one, and writes the rows into rome.db. A
//     kind that already has a connection keeps it. Runs in the instance's
//     image with the instance stopped, so the tokens never leave the process;
//     it prints the result without them.
//   node old-connections.mjs link <instance url> <cookies.json> <fake-slack url> <written.json> <token-file.json>
//     Links the bot's account to the Concierge through the dashboard's own
//     route, then checks that each connection came back: listed, the bot's
//     Socket Mode connection open now, the OAuth tokens in the connector's token
//     file (ctl.sh token-file's answer). Runs on the host.
//
// What each row holds, and where in rome it comes from, is in DIFFERENCES.md.

import { randomUUID } from "node:crypto";
import { chownSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [mode, ...rest] = process.argv.slice(2);

// Rome Cloud's earlier Slack OAuth app asked for these
// (rome-cloud packages/pantheon/src/lib/oauth/slack.ts, BOT_SCOPES and USER_SCOPES).
const OLD_OAUTH_BOT_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
  "users:read.email",
  "reactions:read",
  "files:read",
];
const OLD_OAUTH_USER_SCOPES = ["search:read"];
const CONCIERGE = "core:concierge";

if (mode === "write") await write(rest);
else if (mode === "link") await link(...rest);
else fail(2, "usage: old-connections.mjs write|link …");

async function prepare(fake, team, guardian) {
  if (!fake || !team || !guardian)
    fail(2, "usage: write --fake <url> --team <team> --guardian <member>");
  const control = (path, body) => post(`${fake}/_control${path}`, body);
  const slack = async (method, token, query) => {
    const r = await fetch(`${fake}/api/${method}?${new URLSearchParams(query ?? {})}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await r.json();
    if (!body.ok) fail(1, `${method} answered ${body.error}`);
    return body;
  };
  const now = Math.floor(Date.now() / 1000);

  // slack_bot: the guardian made a Slack app on Socket Mode and pasted its two
  // tokens. Setup read the bot from auth.test, its app from bots.info, and kept
  // the profile probeSlackBot builds (integrations/slack-bot.ts).
  const bot = await control("/other-app", {
    team,
    kind: "socket_bot",
    name: "Rome Bot",
    installed_by: guardian,
  });
  const who = await slack("auth.test", bot.bot_token);
  const appId =
    who.app_id ?? (await slack("bots.info", bot.bot_token, { bot: who.bot_id })).bot.app_id;
  const botProfile = {
    teamId: who.team_id,
    botUserId: who.user_id,
    ...(who.team ? { workspaceName: who.team } : {}),
    ...(who.user ? { botUsername: who.user } : {}),
    ...(appId ? { appId } : {}),
  };

  // slack: Rome Cloud's OAuth app, installed by the guardian. Rome Cloud read
  // the workspace from auth.test and the installer from users.info; the
  // instance kept the profile grantProfileFromBundle builds (providers-import.ts).
  const cloudApp = await control("/other-app", {
    team,
    kind: "oauth",
    name: "Rome",
    scopes: OLD_OAUTH_BOT_SCOPES.join(","),
    user_scopes: OLD_OAUTH_USER_SCOPES.join(","),
    installed_by: guardian,
  });
  const ws = await slack("auth.test", cloudApp.bot_token);
  const user = (await slack("users.info", cloudApp.bot_token, { user: guardian })).user;
  const p = user.profile ?? {};
  const cloudProfile = dropEmpty({
    subject: `${ws.team_id}:${guardian}`,
    displayName: p.real_name ?? user.real_name ?? p.display_name ?? ws.user,
    email: p.email,
    avatarUrl: p.image_512 ?? p.image_192 ?? p.image_72,
    login: ws.team,
    scopes: OLD_OAUTH_BOT_SCOPES,
    teamId: ws.team_id,
  });

  return {
    team,
    guardian,
    now,
    slack_bot: {
      app_id: bot.app_id,
      bot_user_id: bot.bot_user_id,
      material: { botToken: bot.bot_token, appToken: bot.app_token },
      profile: botProfile,
      account_id: `${botProfile.teamId}/${botProfile.botUserId}`,
    },
    slack: {
      app_id: cloudApp.app_id,
      bot_user_id: cloudApp.bot_user_id,
      material: { botToken: cloudApp.bot_token, userToken: cloudApp.user_token },
      profile: cloudProfile,
      account_id: `${ws.team_id}:${guardian}`,
    },
  };
}

async function write(argv) {
  const { DatabaseSync } = await import("node:sqlite");
  const at = argv.indexOf("--db");
  const dbPath = at >= 0 ? argv[at + 1] : findDatabase(["/home/rome", "/home/user"]);
  if (!dbPath) fail(2, "no rome.db found under ~/.rome in the instance's homes");
  const flag = (name) => {
    const k = argv.indexOf(`--${name}`);
    return k >= 0 ? argv[k + 1] : undefined;
  };
  const spec = await prepare(flag("fake"), flag("team"), flag("guardian"));
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const out = { ok: true, db: dbPath, team: spec.team, guardian: spec.guardian };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const kind of ["slack_bot", "slack"]) {
      const s = spec[kind];
      const held = one(
        `SELECT c.id, g.account_id FROM connections c LEFT JOIN connection_grants g ON g.custody = c.id
         WHERE c.connection_kind = ?`,
        kind,
      );
      const base = {
        app_id: s.app_id,
        bot_user_id: s.bot_user_id,
        account_id: s.account_id,
      };
      if (held) {
        out[kind] = {
          ...base,
          connection_id: held.id,
          account_id: held.account_id,
          written: false,
        };
        continue;
      }
      const id = randomUUID();
      // ConnectionRegistry.mint: the label is the kind's name when none is given.
      run(
        "INSERT INTO connections (id, connection_kind, label, created_at) VALUES (?, ?, ?, ?)",
        id,
        kind,
        kind,
        spec.now,
      );
      // ConnectionRegistry.giveGrant through repository-db.ts grantColumns:
      // an authorized grant with a credential that never expires.
      run(
        `INSERT INTO connection_grants
           (custody, state, credential, profile, granted_at, grant_epoch, platform, account_id)
         VALUES (?, 'authorized', ?, ?, ?, ?, 'slack', ?)`,
        id,
        JSON.stringify({ material: { kind: "inline", record: s.material }, expiresAt: "never" }),
        JSON.stringify(s.profile),
        spec.now,
        randomUUID(),
        s.account_id,
      );
      if (kind === "slack_bot") {
        // The "connected" event: a kind that talks claims a channel, which
        // takes an opaque id because the kind links to its own account, and
        // the account is added with no agent yet (index.ts, channel-records.ts
        // claim, connected-accounts.ts add). The account's name is learned
        // from the grant (own-account-profiles.ts).
        run(
          `INSERT INTO channels (id, connection_kind, platform, connection_id, platform_account_id, created_at)
           VALUES (?, 'slack_bot', 'slack', ?, ?, ?)`,
          randomUUID(),
          id,
          s.account_id,
          spec.now,
        );
        run(
          "INSERT OR IGNORE INTO connected_accounts (platform, account_id, agent) VALUES ('slack', ?, NULL)",
          s.account_id,
        );
        const { botUsername, workspaceName } = s.profile;
        run(
          `INSERT OR IGNORE INTO account_profiles
             (platform, account_id, display_name, handle, avatar_url, source, updated_at)
           VALUES ('slack', ?, ?, ?, NULL, 'connection', ?)`,
          s.account_id,
          botUsername && workspaceName
            ? `${botUsername} (${workspaceName})`
            : (botUsername ?? workspaceName ?? null),
          botUsername ? `@${botUsername}` : null,
          spec.now,
        );
      }
      out[kind] = { ...base, connection_id: id, written: true };
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    fail(1, String(error.message ?? error));
  }
  db.close();
  keepOwner(dbPath);
  console.log(JSON.stringify(out));
}

async function link(instance, cookiesFile, fake, writtenFile, tokenFile) {
  if (!tokenFile) {
    fail(
      2,
      "usage: link <instance url> <cookies.json> <fake-slack url> <written.json> <token-file.json>",
    );
  }
  const tokens = JSON.parse(readFileSync(tokenFile, "utf8"));
  const written = JSON.parse(readFileSync(writtenFile, "utf8"));
  const cookies = JSON.parse(readFileSync(cookiesFile, "utf8"));
  const headers = {
    cookie: Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; "),
    origin: instance,
    "content-type": "application/json",
  };
  const bot = written.slack_bot;
  // What a guardian does on main after connecting a bot: pick the agent that
  // answers in it (Settings → Connections). Rome hears the bot only then.
  const linked = await fetch(
    `${instance}/api/connected-accounts/slack/${encodeURIComponent(bot.account_id)}/agent`,
    { method: "PUT", headers, body: JSON.stringify({ agent: CONCIERGE }) },
  );
  const linkBody = await linked.json().catch(() => null);

  const listed = await fetch(`${instance}/api/connections`, { headers }).then((r) => r.json());
  const views = Array.isArray(listed) ? listed : (listed.connections ?? []);
  const view = (id) => views.find((v) => v.id === id) ?? null;
  // The bot's Socket Mode connection is open now: one from before the
  // restart has closed, so the fake's history of hellos would not do.
  let open = false;
  const waitS = Number(process.env.OLD_CONNECTIONS_WAIT_S ?? 60);
  for (let i = 0; i < waitS && !open; i++) {
    const { open_sockets } = await fetch(`${fake}/_control/state`).then((r) => r.json());
    open = open_sockets.some((x) => x.app_id === bot.app_id);
    if (!open) await new Promise((r) => setTimeout(r, 1000));
  }
  // The fake shows each app's token tails, never the tokens.
  const { other_apps } = await fetch(`${fake}/_control/state`).then((r) => r.json());
  // Both tokens: search.messages and the other user-token calls need the user's.
  const cloudApp = other_apps.find((a) => a.app_id === written.slack.app_id);
  const checks = {
    bot_agent_linked: linked.ok,
    bot_agent: linkBody?.account?.agent ?? null,
    bot_listed: view(bot.connection_id) !== null,
    bot_socket_open: open,
    oauth_listed: view(written.slack.connection_id) !== null,
    oauth_token_file:
      tokens.exists === true &&
      Boolean(cloudApp?.bot_token_tail && cloudApp?.user_token_tail) &&
      tokens.bot_token_tail === cloudApp.bot_token_tail &&
      tokens.user_token_tail === cloudApp.user_token_tail,
  };
  console.log(JSON.stringify({ ...written, checks }));
  if (!Object.values(checks).every(Boolean)) process.exit(1);
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

function dropEmpty(o) {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""),
  );
}

async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await r.json();
  if (!r.ok || out.ok === false) fail(1, `${url} answered ${r.status} ${out.error ?? ""}`);
  return out;
}

function fail(code, message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}
