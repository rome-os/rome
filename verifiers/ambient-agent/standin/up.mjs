// Brings up a fake environment for proving the verifier: the environment's
// own fake Slack (read from a commit of the environment repository) over this
// folder's workspaces.json, the stand-in instance (instance.mjs) installed in
// its workspace, a stand-in product checkout for rule 4, and an env.json in
// the environment's shape.
//
// The fake's history limit stays on, with a short window so a proof runs in
// minutes; the verifier reads the window from env.json.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const SIGNING_SECRET = "standin-signing-secret";
const CLIENT_SECRET = "standin-client-secret";
const CLIENT_ID = "1111111111.2222222222";
const SCOPES =
  "app_mentions:read,channels:history,groups:history,chat:write,im:history,im:read,im:write";

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** The repository and commit the fake Slack is read from. */
export function fakeSource() {
  const repo =
    process.env.STANDIN_ENV_REPO ??
    join(homedir(), ".rome-environments/ambient-agent/environment-repo");
  const ref = process.env.STANDIN_ENV_REF ?? "HEAD";
  const commit = execFileSync("git", ["-C", repo, "rev-parse", ref]).toString().trim();
  return { repo, commit };
}

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

/**
 * A product checkout for rule 4: a commit taken as origin/main, then the
 * product's commit on top. `kinds` puts the product's change under
 * connections/kinds/. Its test runner stands in for rstest: it runs no
 * TypeScript, and reports the verifier's two tests as named in the file it is
 * given, passing both, or with `needsMore` failing the recall test. The
 * product commit holds the test-kit helper unless `noHelper`.
 */
function productCheckout(dir, { kinds, needsMore, noHelper }) {
  const repo = join(dir, "rome");
  mkdirSync(join(repo, "packages/core/src/connections/kinds/standin"), { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.standin-*\n");
  writeFileSync(
    join(repo, "packages/core/src/connections/kinds/standin/kind.ts"),
    "export const kind = 'standin';\n",
  );
  writeFileSync(join(repo, "scripts/test-env.sh"), '#!/usr/bin/env bash\nexec "$@"\n');
  chmodSync(join(repo, "scripts/test-env.sh"), 0o755);
  git(dir, "init", "-q", "-b", "main", repo);
  git(repo, "-c", "user.email=standin@test", "-c", "user.name=standin", "add", ".");
  git(repo, "-c", "user.email=standin@test", "-c", "user.name=standin", "commit", "-qm", "main");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  if (kinds)
    writeFileSync(
      join(repo, "packages/core/src/connections/kinds/standin/kind.ts"),
      "export const kind = 'standin';\nexport const readsGroups = true;\n",
    );
  else writeFileSync(join(repo, "packages/core/src/ambient.ts"), "export const ambient = true;\n");
  if (!noHelper) {
    mkdirSync(join(repo, "packages/core/src/test/kit"), { recursive: true });
    writeFileSync(
      join(repo, "packages/core/src/test/kit/workspace-account.ts"),
      "export async function bootWorkspaceAccount() {}\n",
    );
  }
  git(repo, "-c", "user.email=standin@test", "-c", "user.name=standin", "add", ".");
  git(repo, "-c", "user.email=standin@test", "-c", "user.name=standin", "commit", "-qm", "product");
  writeFileSync(join(repo, ".standin-4b"), needsMore ? "needs-more" : "pass");
  copyFileSync(join(here, "rstest.cjs"), join(repo, "node_modules/.bin/rstest"));
  chmodSync(join(repo, "node_modules/.bin/rstest"), 0o755);
  return repo;
}

/**
 * Starts everything under `dir` with `breaks` (instance.mjs's BREAK) and the
 * rule 4 options. Returns {envPath, slackUrl, down}.
 */
export async function up(
  dir,
  {
    breaks = "",
    kinds = false,
    needsMore = false,
    noHelper = false,
    windowMs = 1500,
    workMs = 2000,
  } = {},
) {
  mkdirSync(dir, { recursive: true });
  const { repo, commit } = fakeSource();
  const show = (path) => execFileSync("git", ["-C", repo, "show", `${commit}:${path}`]);
  mkdirSync(join(dir, "fake-slack"), { recursive: true });
  writeFileSync(
    join(dir, "fake-slack/server.mjs"),
    show("environments/slack-app/fake-slack/server.mjs"),
  );
  // The verifier's own workspace: 5 shared chats with the bot and 4 members besides the guardian.
  copyFileSync(join(here, "workspaces.json"), join(dir, "fake-slack/workspaces.json"));
  const { start, loadConfig } = await import(join(dir, "fake-slack/server.mjs"));

  const instancePort = await freePort();
  const slackPort = await freePort();
  const config = loadConfig({
    port: slackPort,
    workspacesFile: join(dir, "fake-slack/workspaces.json"),
    signingSecret: SIGNING_SECRET,
    clientSecret: CLIENT_SECRET,
    clientId: CLIENT_ID,
    eventsUrl: `http://127.0.0.1:${instancePort}/events`,
    retryDelaysMs: "500",
    historyLimit: "on",
    historyWindowMs: windowMs,
  });
  const { servers } = start(config);
  const slack = `http://127.0.0.1:${slackPort}`;
  await new Promise((r) => (servers[0].listening ? r() : servers[0].once("listening", r)));

  // Install the app in workspace A as its guardian, through the approve screen.
  const workspaces = JSON.parse(
    readFileSync(join(dir, "fake-slack/workspaces.json"), "utf8"),
  ).workspaces;
  const a = workspaces[0];
  const guardian = a.members.find((m) => m.is_owner).id;
  const redirect = "http://127.0.0.1/standin/callback";
  const approved = await fetch(`${slack}/oauth/v2/authorize/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      decision: "allow",
      team: a.id,
      user: guardian,
      scope: SCOPES,
      redirect_uri: redirect,
      state: "s",
    }),
  });
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const access = await (
    await fetch(`${slack}/api/oauth.v2.access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirect,
      }),
    })
  ).json();
  if (!access.ok) throw new Error(`stand-in install failed: ${JSON.stringify(access)}`);
  writeFileSync(join(dir, "token"), access.access_token);

  const general = a.channels.find((c) => c.name === "general").id;
  writeFileSync(
    join(dir, "instance.json"),
    JSON.stringify({
      env: {
        PORT: String(instancePort),
        SLACK: slack,
        SIGNING_SECRET,
        TOKEN_FILE: join(dir, "token"),
        BREAK: breaks,
        GENERAL: general,
        GUARDIAN: guardian,
        POLL_MS: String(windowMs * 2),
        WORK_MS: String(workMs),
      },
    }),
  );
  const ctl = [process.execPath, join(here, "ctl.mjs"), dir];
  const started = spawnSync(ctl[0], [...ctl.slice(1), "start"]);
  if (started.status !== 0) throw new Error(`stand-in instance did not start: ${started.stderr}`);

  const rome = productCheckout(dir, { kinds, needsMore, noHelper });
  const env = {
    version: 1,
    commits: { environment: commit, rome: git(rome, "rev-parse", "HEAD"), rome_ref: "standin" },
    agent: {
      model: "standin",
      effort: "standin",
      model_proxy: { usage_command: [process.execPath, join(here, "usage.mjs")] },
    },
    repos: { rome, rome_dependencies: "installed" },
    fake_slack: {
      url: slack,
      control: `${slack}/_control`,
      history_limit: {
        on: true,
        requests_per_minute: 60_000 / windowMs,
        window_ms: windowMs,
        max_messages: 15,
      },
      workspaces: workspaces.map((w) => ({
        id: w.id,
        guardian: w.members.find((m) => m.is_owner)?.id ?? null,
      })),
    },
    instances: [
      {
        name: "standin",
        url: `http://127.0.0.1:${instancePort}`,
        control: {
          stop: [...ctl, "stop"],
          start: [...ctl, "start"],
          status: [...ctl, "status"],
          logs: [...ctl, "logs"],
        },
      },
    ],
  };
  const envPath = join(dir, "env.json");
  writeFileSync(envPath, JSON.stringify(env, null, 2));
  return {
    envPath,
    slack,
    rome,
    down: async () => {
      spawnSync(ctl[0], [...ctl.slice(1), "stop"]);
      for (const s of servers) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
      }
    },
  };
}
