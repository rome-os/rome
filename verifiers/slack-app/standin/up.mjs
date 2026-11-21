// Starts the stand-in world: the environment's fake Slack, the stand-in Rome
// Cloud and relay, two stand-in instances, a control server that stops and
// starts them, and two small git checkouts for R11. Writes env.json in the
// shape ../CONTRACT.md gives, then runs until SIGTERM.
//
// Usage: node up.mjs <fake Slack dir> <work dir>. BREAK (comma list) breaks
// rules; the list is in ../README.md, "Stand-in".

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCloud } from "./cloud.mjs";
import { send, serve } from "./serve.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const [fakeDir, workDir] = process.argv.slice(2).map((p) => resolve(p));
const breaks = new Set((process.env.BREAK ?? "").split(",").filter(Boolean));
const rand = () => randomBytes(12).toString("hex");
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

// Waits until something answers HTTP at `url`, so the next server that asks
// the system for a free port cannot be handed this one.
async function listening(url) {
  for (let i = 0; i < 200; i++) {
    if (
      await fetch(url).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nothing answered at ${url}`);
}

// A port free now. Whatever takes it next must be listening before another
// server is started, which `listening` waits for.
const freePort = () =>
  new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });

// The environment's fake Slack, loaded from its own folder.
const fake = await import(join(fakeDir, "server.mjs"));
const secrets = { clientSecret: rand(), signingSecret: rand() };
// Port 0: fake Slack binds every interface, so only it can know a port that
// is free on all of them.
const { slack, servers } = fake.start(
  fake.loadConfig({
    port: 0,
    workspacesFile: join(fakeDir, "workspaces.json"),
    retryDelaysMs: "200,500,1000",
    ...secrets,
  }),
);
if (!servers[0].listening) await new Promise((r) => servers[0].once("listening", r));
const slackUrl = `http://127.0.0.1:${servers[0].address().port}`;
await listening(`${slackUrl}/_control/state`);

const instanceSecrets = { a: rand(), b: rand() };
const cloud = await startCloud({
  slackUrl,
  clientId: slack.config.clientId,
  ownTeams: slack.config.workspaces.slice(0, 2).map((w) => w.id),
  ...secrets,
  instanceSecrets,
  breaks,
});
slack.config.eventsUrl = `${cloud.url}/slack/events`;

const children = {};
const ports = {};
function startInstance(name) {
  if (children[name]) return;
  const child = spawn(process.execPath, [join(here, "instance.mjs")], {
    stdio: "inherit",
    env: {
      ...process.env,
      NAME: name,
      PORT: String(ports[name]),
      CLOUD: cloud.url,
      SLACK: slackUrl,
      SECRET: instanceSecrets[name],
      STATE_FILE: join(workDir, `instance-${name}.json`),
    },
  });
  children[name] = child;
  child.on("exit", () => {
    if (children[name] === child) delete children[name];
  });
}
const stopInstance = (name) =>
  new Promise((r) => {
    const child = children[name];
    if (!child) return r();
    child.on("exit", () => r());
    child.kill("SIGTERM");
  });
const control = await serve(async (req, res, url) => {
  // R10's seed: the older slack_bot and slack an upgrade leaves, written
  // into the stopped instance, which then starts again.
  const oc = url.pathname.match(/^\/instances\/(a|b)\/old-connections$/);
  if (oc && req.method === "POST") {
    const name = oc[1];
    const file = join(workDir, `instance-${name}.json`);
    const team = slack.config.workspaces[name === "a" ? 0 : 1].id;
    const other = async (kind) =>
      (
        await fetch(`${slackUrl}/_control/other-app`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ team, kind }),
        })
      ).json();
    const bot = await other("socket_bot");
    const oauth = await other("oauth");
    await stopInstance(name);
    const db = JSON.parse(readFileSync(file, "utf8"));
    db.old = [
      { kind: "slack_bot", id: `old_bot_${bot.app_id}`, appId: bot.app_id, botToken: bot.bot_token, appToken: bot.app_token },
      { kind: "slack", id: `old_oauth_${oauth.app_id}`, appId: oauth.app_id, botToken: oauth.bot_token, userToken: oauth.user_token },
    ];
    db.tokenFile = { botToken: oauth.bot_token, userToken: oauth.user_token, teamId: team };
    delete db.oldStarted;
    writeFileSync(file, JSON.stringify(db));
    startInstance(name);
    await listening(`http://127.0.0.1:${ports[name]}/`);
    const out = (o, id) => ({ connection_id: id, account_id: `${team}/${o.bot_user_id}`, app_id: o.app_id, bot_user_id: o.bot_user_id });
    return send(res, 200, {
      slack_bot: out(bot, db.old[0].id),
      slack: out(oauth, db.old[1].id),
      checks: { bot_listed: true, oauth_listed: true },
    });
  }

  const m = url.pathname.match(/^\/instances\/(a|b)\/(stop|start)$/);
  if (!m || req.method !== "POST") return send(res, 404, { error: "not found" });
  if (m[2] === "stop") await stopInstance(m[1]);
  else startInstance(m[1]);
  // Broken R6-stop-error: stop stops the instance, then reports a failure.
  if (m[2] === "stop" && breaks.has("R6-stop-error"))
    return send(res, 500, { error: "stopped, then failed" });
  return send(res, 200, { ok: true });
});

// The instances take their ports only after every server here is listening,
// and env.json is written only once both answer.
ports.a = await freePort();
startInstance("a");
await listening(`http://127.0.0.1:${ports.a}/`);
ports.b = await freePort();
startInstance("b");
await listening(`http://127.0.0.1:${ports.b}/`);

// R11's checkouts: a rome-cloud with a binding table on top of main, and a
// rome whose import rules pass. Broken R11 adds Slack code to the relay;
// broken R11-store keeps the bot token in Rome Cloud.
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
const write = (dir, path, text) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const commitAll = (dir, msg) => {
  git(dir, "add", "-A");
  git(
    dir,
    "-c",
    "user.name=stand-in",
    "-c",
    "user.email=stand-in@example.test",
    "commit",
    "-qm",
    msg,
  );
};
const romeCloud = join(workDir, "rome-cloud");
mkdirSync(romeCloud);
git(romeCloud, "init", "-q", "-b", "main");
write(romeCloud, "webhook-relay/src/index.ts", "export const relay = 'mailboxes';\n");
write(
  romeCloud,
  "packages/pantheon/src/db/schema.ts",
  "export const instances = table('instances', {\n  id: text('id'),\n});\n",
);
commitAll(romeCloud, "main");
git(romeCloud, "checkout", "-q", "-b", "product");
write(
  romeCloud,
  "packages/pantheon/src/db/schema.ts",
  "export const instances = table('instances', {\n  id: text('id'),\n});\nexport const slackBindings = table('slack_bindings', {\n  teamId: text('team_id'),\n  instanceId: text('instance_id'),\n" +
    (breaks.has("R11-store") ? "  botToken: text('bot_token'),\n" : "") +
    "  createdAt: integer('created_at'),\n});\n",
);
// Constraints on the binding table are not stored data, so R11 passes them.
write(
  romeCloud,
  "packages/pantheon/drizzle/0001_slack_bindings.sql",
  "CREATE TABLE slack_bindings_sql (team_id TEXT, instance_id TEXT, PRIMARY KEY (team_id), UNIQUE (instance_id, team_id));\n" +
    'ALTER TABLE "slack_bindings" ADD CONSTRAINT "slack_bindings_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "instances"("id");\n' +
    'ALTER TABLE "slack_bindings" ADD UNIQUE ("team_id");\n' +
    // Rome Cloud's own name for the instance a row belongs to.
    'ALTER TABLE "slack_bindings" ADD COLUMN "account_instance_id" text;\n' +
    // A claim counter, so a late release cannot end a newer claim: binding.
    'ALTER TABLE "slack_bindings" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;\n',
);
// Allowed beside the binding: the means of delivery, and a sign-in attempt
// like Rome Cloud's: fields that say where to return the browser, and the
// encrypted outcome, cleared on redemption. Expired attempts are deleted.
// Broken R11-token-kept never clears the outcome; R11-no-sweep never deletes
// expired attempts.
write(
  romeCloud,
  "packages/pantheon/src/db/slack-sign-in.ts",
  "export const slackDelivery = pgTable('slack_delivery', {\n  teamId: text('team_id'),\n  mailboxId: text('mailbox_id'),\n  forwardSecretHash: text('forward_secret_hash'),\n});\n" +
    "export const slackSignIns = pgTable('slack_sign_ins', {\n  state: text('state'),\n  instanceState: text('instance_state'),\n  callbackOrigin: text('callback_origin'),\n  redirectUri: text('redirect_uri'),\n  codeChallenge: text('code_challenge'),\n  handoffHash: text('handoff_hash'),\n  result: text('result'),\n  expiresAt: timestamp('expires_at'),\n  consumedAt: timestamp('consumed_at'),\n" +
    (breaks.has("R11-message") ? "  messageText: text('message_text'),\n" : "") +
    (breaks.has("R11-member") ? "  email: text('email'),\n" : "") +
    "});\n",
);
write(
  romeCloud,
  "packages/pantheon/src/slack/redeem.ts",
  "export const redeem = (db, hash, now) =>\n  db.update(slackSignIns).set({ consumedAt: now" +
    (breaks.has("R11-token-kept") ? "" : ", result: null") +
    " }).where(eq(slackSignIns.handoffHash, hash));\n" +
    (breaks.has("R11-no-sweep")
      ? ""
      : "export const sweep = (db, now) =>\n  db.delete(slackSignIns).where(lt(slackSignIns.expiresAt, now));\n"),
);
if (breaks.has("R11-sql"))
  write(
    romeCloud,
    "packages/pantheon/drizzle/0003_slack_secrets.sql",
    "CREATE TABLE slack_secrets (team_id TEXT, bot_token TEXT);\n",
  );
if (breaks.has("R11-namespace"))
  write(
    romeCloud,
    "packages/pantheon/src/db/schema-ns.ts",
    "import * as pg from 'drizzle-orm/pg-core';\nexport const slackTokens = pg.pgTable('slack_tokens', {\n  botToken: pg.text('bot_token'),\n});\n",
  );
if (breaks.has("R11-eof"))
  write(
    romeCloud,
    "packages/pantheon/drizzle/0004_slack_eof.sql",
    "CREATE TABLE slack_eof (team_id TEXT, bot_token TEXT)",
  );
if (breaks.has("R11-migration"))
  write(
    romeCloud,
    "packages/pantheon/drizzle/0002_slack_token.sql",
    'ALTER TABLE "slack_bindings" ADD COLUMN "bot_token" text;\n',
  );
if (breaks.has("R11"))
  write(romeCloud, "webhook-relay/src/slack.ts", "export const verifySlack = () => true;\n");
commitAll(romeCloud, "product");

const rome = join(workDir, "rome");
mkdirSync(rome);
git(rome, "init", "-q", "-b", "main");
write(
  rome,
  "package.json",
  `${JSON.stringify({ name: "rome-stand-in", private: true, scripts: { "lint:imports": "node -e 0" } })}\n`,
);
// An import from an app that main already has is not this product's.
write(
  rome,
  "packages/core/src/connections/legacy.ts",
  "import { old } from '../../../../rome_apps/legacy/index.js';\n",
);
commitAll(rome, "main");
git(rome, "checkout", "-q", "-b", "product");
write(
  rome,
  "packages/core/src/connections/slack-app.ts",
  "import { send } from './send.js';\n" +
    (breaks.has("R11-import")
      ? "import { app } from '../../../../rome_apps/slack/index.js';\n"
      : ""),
);
commitAll(rome, "product");

const env = {
  ruleSet: "v4",
  commits: {
    rome: git(rome, "rev-parse", "HEAD").toString().trim(),
    romeCloud: git(romeCloud, "rev-parse", "HEAD").toString().trim(),
    environment: "stand-in",
  },
  model: "stand-in (no model)",
  differences: { product: "stand-in", stopSeconds: 2, breaks: [...breaks] },
  stopSeconds: 2,
  timeouts: { replySeconds: 5, settleSeconds: 1, restartSeconds: 10, reachSeconds: 30 },
  repos: { rome, romeCloud, romeCloudBase: "main", romeBase: "main" },
  slack: { url: slackUrl, control: `${slackUrl}/_control` },
  romeCloud: { url: cloud.url, query: [process.execPath, join(here, "query.mjs"), cloud.url] },
  instances: ["a", "b"].map((name) => ({
    name,
    api: `http://127.0.0.1:${ports[name]}/api`,
    control: {
      stop: `${control.url}/instances/${name}/stop`,
      start: `${control.url}/instances/${name}/start`,
      oldConnections: `${control.url}/instances/${name}/old-connections`,
      // The connection's port and Chats' record, served by the instance
      // itself. Variant no-port gives neither, as the environment on main.
      ...(process.env.STANDIN_NO_PORT
        ? {}
        : { port: `http://127.0.0.1:${ports[name]}/_port`, record: `http://127.0.0.1:${ports[name]}/_record` }),
      // Warnings the stand-in logs; only R13-short-memory writes any.
      logs: `cat ${JSON.stringify(join(workDir, `instance-${name}-warnings.log`))} 2>/dev/null || true`,
    },
    connect: { kind: "slack_app", grant: "bot" },
  })),
};
writeFileSync(join(workDir, "env.json"), `${JSON.stringify(env, null, 2)}\n`);
process.stderr.write(`[stand-in] up, breaks: ${[...breaks].join(",") || "none"}\n`);

process.on("SIGTERM", async () => {
  await Promise.all(Object.keys(children).map(stopInstance));
  process.exit(0);
});
