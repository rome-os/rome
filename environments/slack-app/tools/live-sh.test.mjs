// Runs live.sh up twice and down with docker and curl stubbed, against this
// checkout's HEAD and a throwaway rome-cloud repository.
// Run: node --test environments/slack-app/tools/live-sh.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const live = fileURLToPath(new URL("../live.sh", import.meta.url));

test("a second up keeps the certificate and restarts what reads it; down leaves nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-sh-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  const stub = (name, body) => {
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env bash\necho "${name} $*" >>"${log}"\n${body}\nexit 0\n`,
    );
    chmodSync(join(bin, name), 0o755);
  };
  stub("docker", `case "$*" in *"run --rm enroll"*) echo '{}';; esac`);
  stub("curl", `case "$*" in *api/http/routers*) echo '[]';; esac`);
  const cloud = join(dir, "rome-cloud");
  const git = (...a) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: cloud });
  mkdirSync(join(cloud, "webhook-relay"), { recursive: true });
  writeFileSync(join(cloud, "webhook-relay/.keep"), "");
  execFileSync("git", ["init", "-q", "-b", "main", cloud]);
  git("add", ".");
  git("commit", "-q", "-m", "c");
  const state = join(dir, "state");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ROME_CLOUD_DIR: cloud,
    SLACKENV_LIVE_STATE: state,
    SLACK_APP_CLIENT_ID: "cid",
    SLACK_APP_CLIENT_SECRET: "the-client-secret",
    SLACK_APP_SIGNING_SECRET: "the-signing-secret",
    SLACKENV_ANTHROPIC_API_KEY: "k",
  };
  const run = (...args) =>
    execFileSync(live, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("up", "--rome", "HEAD", "--rome-cloud", "main");
    const cert = readFileSync(join(state, "tls/tls.crt"), "utf8");
    writeFileSync(log, "");
    run("up", "--rome", "HEAD", "--rome-cloud", "main");
    assert.equal(readFileSync(join(state, "tls/tls.crt"), "utf8"), cert);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /up -d --force-recreate edge /);
    assert.match(calls, /up -d --force-recreate rome\n/);
    // Rome Cloud must not take the instance's public name for one it hosts
    // (https://<slug>.<PANTHEON_DOMAIN>), or it shows no consent form.
    const pantheonEnv = readFileSync(join(state, "pantheon.env"), "utf8");
    const domain = pantheonEnv.match(/^PANTHEON_DOMAIN=(.*)$/m)[1];
    const romeHost = readFileSync(join(state, "compose.env"), "utf8").match(/^ROME_HOST=(.*)$/m)[1];
    assert.equal(romeHost, "slack.romeos.dev");
    assert.ok(!romeHost.endsWith(`.${domain}`), domain);
    // The Slack app's secrets reach no file this environment writes.
    for (const f of ["compose.env", "pantheon.env", "secrets.env"]) {
      const text = readFileSync(join(state, f), "utf8");
      assert.ok(!/the-client-secret|the-signing-secret/.test(text), f);
    }
    // Another slug makes a certificate for its own names.
    run("up", "--rome", "HEAD", "--rome-cloud", "main", "--slug", "other");
    assert.notEqual(readFileSync(join(state, "tls/tls.crt"), "utf8"), cert);
  } finally {
    run("down");
  }
  assert.ok(!existsSync(state));
  // Without a rome-cloud checkout, it names the variable to set.
  const missing = (() => {
    try {
      execFileSync(live, ["up", "--rome", "HEAD"], {
        env: { ...env, ROME_CLOUD_DIR: join(dir, "nowhere") },
        stdio: "pipe",
      });
    } catch (e) {
      return String(e.stderr);
    }
  })();
  assert.match(missing, /set ROME_CLOUD_DIR/);
});
