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
    // Slack's history limit is off here: paging through it, a minute a page,
    // would outlast the stand-in's reply timeout. The real run keeps it on.
    historyLimit: false,
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
  // Wipes the instance's copy of one Slack conversation: stop, wipe, start.
  const w = url.pathname.match(/^\/instances\/(a|b)\/wipe$/);
  if (w && req.method === "POST") {
    const conversation = url.searchParams.get("conversation");
    await stopInstance(w[1]);
    const file = join(workDir, `instance-${w[1]}.json`);
    const db = JSON.parse(readFileSync(file, "utf8"));
    const before = db.messages.length;
    db.messages = db.messages.filter((m) => m.channel !== conversation);
    writeFileSync(file, JSON.stringify(db));
    startInstance(w[1]);
    await listening(`http://127.0.0.1:${ports[w[1]]}/`);
    return send(res, 200, { messages: before - db.messages.length });
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
    'ALTER TABLE "slack_bindings" ADD COLUMN "account_instance_id" text;\n',
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
  ruleSet: "v2",
  commits: {
    rome: git(rome, "rev-parse", "HEAD").toString().trim(),
    romeCloud: git(romeCloud, "rev-parse", "HEAD").toString().trim(),
    environment: "stand-in",
  },
  model: "stand-in (no model)",
  differences: { product: "stand-in", stopSeconds: 2, breaks: [...breaks] },
  stopSeconds: 2,
  timeouts: { replySeconds: 5, settleSeconds: 1, restartSeconds: 10 },
  repos: { rome, romeCloud, romeCloudBase: "main", romeBase: "main" },
  slack: { url: slackUrl, control: `${slackUrl}/_control` },
  romeCloud: { url: cloud.url, query: [process.execPath, join(here, "query.mjs"), cloud.url] },
  instances: ["a", "b"].map((name) => ({
    name,
    api: `http://127.0.0.1:${ports[name]}/api`,
    control: {
      stop: `${control.url}/instances/${name}/stop`,
      start: `${control.url}/instances/${name}/start`,
      wipeChat: `${control.url}/instances/${name}/wipe`,
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
