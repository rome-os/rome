// Starts the Worker proof's world: the environment's fake Slack, the
// stand-in slack-gateway Worker with its Rome Cloud and relay parts
// (gateway.mjs), and the checkouts R11 reads: a worktree of the real
// rome-cloud at the Worker's commit, broken on purpose for W-R11-*, and a
// small rome. Writes env.json, then runs until SIGTERM. The verifier's agent
// runs as each instance on this machine, with the stand-in signer.
//
// Usage: node worker-up.mjs <fake Slack dir> <work dir>. BREAK (comma list)
// as in README.md, "Worker proof". ROME_CLOUD_DIR and ROME_CLOUD_REF name the
// rome-cloud checkout and the Worker's commit; ROME_CLOUD_BASE its base.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "./gateway.mjs";
import { send, serve } from "./serve.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const [fakeDir, workDir] = process.argv.slice(2).map((p) => resolve(p));
const breaks = new Set((process.env.BREAK ?? "").split(",").filter(Boolean));
const rand = () => randomBytes(12).toString("hex");
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const fake = await import(join(fakeDir, "server.mjs"));
const secrets = { clientSecret: rand(), signingSecret: rand() };
const { slack, servers } = fake.start(
  fake.loadConfig({ port: 0, workspacesFile: join(fakeDir, "workspaces.json"), retryDelaysMs: "200,500,1000", ...secrets }),
);
if (!servers[0].listening) await new Promise((r) => servers[0].once("listening", r));
const slackUrl = `http://127.0.0.1:${servers[0].address().port}`;

const shared = rand();
const logFile = join(workDir, "slack-gateway.log");
writeFileSync(logFile, "");
const gateway = await startGateway({ slackUrl, clientId: slack.config.clientId, ...secrets, shared, logFile, breaks });
slack.config.eventsUrl = `${gateway.url}/slack/events`;

// Every token the fake issued, as the environment's GET /_control/tokens
// lists them.
const control = await serve(async (req, res, url) => {
  if (url.pathname === "/tokens")
    return send(res, 200, {
      tokens: Object.entries(slack.state.tokens).map(([value, t]) => ({ value, team: t.teamId, kind: t.kind, revoked: Boolean(t.revoked) })),
    });
  return send(res, 404, { error: "not found" });
});

// R11's checkouts: rome-cloud at the Worker's commit, and a small rome.
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const write = (dir, file, text) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const commitAll = (dir, msg) => {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=stand-in", "-c", "user.email=stand-in@example.invalid", "commit", "-q", "-m", msg);
};
const cloudDir = process.env.ROME_CLOUD_DIR ?? "/home/user/rome-cloud";
const cloudRef = process.env.ROME_CLOUD_REF ?? "origin/slack-official-app/slack-gateway";
const romeCloud = join(workDir, "rome-cloud");
git(cloudDir, "worktree", "add", "-q", "--detach", romeCloud, cloudRef);
if (breaks.has("W-R11-message")) {
  const store = join(romeCloud, "gateway/src/slack/store.ts");
  writeFileSync(store, readFileSync(store, "utf8").replace("bound_at INTEGER NOT NULL\n", "bound_at INTEGER NOT NULL,\n      last_text TEXT\n"));
  commitAll(romeCloud, "break: the Worker keeps a message's text");
}
if (breaks.has("W-R11-relay")) {
  write(romeCloud, "webhook-relay/src/slack.ts", "export const verifySlack = () => true;\n");
  commitAll(romeCloud, "break: the relay gains Slack code");
}
const rome = join(workDir, "rome");
mkdirSync(rome);
git(rome, "init", "-q", "-b", "main");
write(rome, "package.json", `${JSON.stringify({ name: "rome-stand-in", private: true, scripts: { "lint:imports": "node -e 0" } })}\n`);
write(rome, "packages/core/src/connections/slack-app.ts", "export const send = () => {};\n");
commitAll(rome, "main");

// Each instance's guardian signed in to Rome Cloud, so the bind goes through
// Rome Cloud's callback, as in the environment. No shared secret.
const agentEnv = (name) => {
  const session = join(workDir, `cloud-session-${name}.json`);
  writeFileSync(session, JSON.stringify({ session: `guardian-${name}` }));
  return `GATEWAY=${gateway.url} CLOUD=${gateway.url} SLACK=${slackUrl} ROME_INSTANCE_TOKEN_URL=${gateway.url}/token/${name} CLOUD_COOKIES=${session} ${process.execPath}`;
};
// Each instance's own folder, as find_secret searches it on a real one: a
// database, a home folder and a log. Broken W-R15-stored writes every bot
// token the fake issued into instance a's database, as a column would.
const instanceDir = (name) => join(workDir, `instance-${name}`);
for (const name of ["a", "b"]) {
  write(instanceDir(name), "data/rome.db", "connections: slack_app team bot_user_id deposit_key\n");
  write(instanceDir(name), "home/rome/.config/rome/settings.json", "{}\n");
  write(instanceDir(name), "logs/rome.log", "Rome started\n");
}
if (breaks.has("W-R15-stored"))
  setInterval(() => {
    const bots = Object.entries(slack.state.tokens).filter(([, t]) => t.kind !== "user").map(([v, t]) => `${t.teamId} ${v}`);
    writeFileSync(join(instanceDir("a"), "data/rome.db"), `connections: slack_app\n${bots.join("\n")}\n`);
  }, 300).unref();
const env = {
  commits: { rome: git(rome, "rev-parse", "HEAD"), romeCloud: git(romeCloud, "rev-parse", "HEAD"), environment: "stand-in" },
  model: "stand-in (no model)",
  differences: { product: "stand-in Worker", stopSeconds: 30, breaks: [...breaks] },
  stopSeconds: 30,
  timeouts: { replySeconds: 10, settleSeconds: 1, restartSeconds: 10, reachSeconds: 30 },
  repos: { rome, romeCloud, romeCloudBase: process.env.ROME_CLOUD_BASE ?? "origin/main", romeBase: "main" },
  slack: { url: slackUrl, control: `${slackUrl}/_control` },
  gateway: { url: gateway.url, logs: `cat ${JSON.stringify(logFile)}`, tokens: `${control.url}/tokens` },
  instances: ["a", "b"].map((name) => ({
    name,
    api: `${gateway.url}/none`,
    control: {
      stop: "true",
      start: "true",
      asInstance: agentEnv(name),
      findSecret: `${process.execPath} ${join(here, "find-secret.mjs")} ${instanceDir(name)}`,
    },
  })),
};
writeFileSync(join(workDir, "env.json"), `${JSON.stringify(env, null, 2)}\n`);
process.stderr.write(`[worker stand-in] up, breaks: ${[...breaks].join(",") || "none"}\n`);
process.on("SIGTERM", () => {
  try {
    git(cloudDir, "worktree", "remove", "--force", romeCloud);
  } catch {}
  process.exit(0);
});
void here;
