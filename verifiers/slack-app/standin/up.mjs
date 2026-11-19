// Starts the stand-in world: the environment's fake Slack, the stand-in Rome
// Cloud and relay, two stand-in instances, a control server that stops and
// starts them, and two small git checkouts for R11. Writes env.json in the
// shape ../CONTRACT.md gives, then runs until SIGTERM.
//
// Usage: node up.mjs <fake Slack dir> <work dir>. BREAK (comma list) breaks
// rules; the list is in ../README.md, "Stand-in".

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const freePort = () =>
  new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });

// The environment's fake Slack, loaded from its own folder.
const fake = await import(join(fakeDir, "server.mjs"));
const slackPort = await freePort();
const secrets = { clientSecret: rand(), signingSecret: rand() };
const { slack } = fake.start(
  fake.loadConfig({
    port: slackPort,
    workspacesFile: join(fakeDir, "workspaces.json"),
    retryDelaysMs: "200,500,1000",
    ...secrets,
  }),
);
const slackUrl = `http://127.0.0.1:${slackPort}`;

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
const ports = { a: await freePort(), b: await freePort() };
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
startInstance("a");
startInstance("b");

const control = await serve(async (req, res, url) => {
  const m = url.pathname.match(/^\/instances\/(a|b)\/(stop|start)$/);
  if (!m || req.method !== "POST") return send(res, 404, { error: "not found" });
  if (m[2] === "stop") await stopInstance(m[1]);
  else startInstance(m[1]);
  return send(res, 200, { ok: true });
});

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
if (breaks.has("R11-sql"))
  write(
    romeCloud,
    "packages/pantheon/drizzle/0003_slack_secrets.sql",
    "CREATE TABLE slack_secrets (team_id TEXT, bot_token TEXT);\n",
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
write(rome, "packages/core/src/connections/slack-app.ts", "import { send } from './send.js';\n");
commitAll(rome, "product");

const env = {
  ruleSet: "v1",
  commits: {
    rome: git(rome, "rev-parse", "HEAD").toString().trim(),
    romeCloud: git(romeCloud, "rev-parse", "HEAD").toString().trim(),
    environment: "stand-in",
  },
  model: "stand-in (no model)",
  differences: { product: "stand-in", stopSeconds: 2, breaks: [...breaks] },
  stopSeconds: 2,
  timeouts: { replySeconds: 5, settleSeconds: 1, restartSeconds: 10 },
  repos: { rome, romeCloud, romeCloudBase: "main" },
  slack: { url: slackUrl, control: `${slackUrl}/_control` },
  romeCloud: { url: cloud.url },
  instances: ["a", "b"].map((name) => ({
    name,
    api: `http://127.0.0.1:${ports[name]}/api`,
    control: {
      stop: `${control.url}/instances/${name}/stop`,
      start: `${control.url}/instances/${name}/start`,
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
