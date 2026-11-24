// Two copies of the environment side by side: up.sh, ctl.sh and down.sh run
// with docker, curl and pnpm stubbed, in a throwaway repository holding this
// folder and a throwaway rome-cloud.
// Run: node --test environments/slack-app/tools/copies.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const envSrc = fileURLToPath(new URL("..", import.meta.url));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "slackenv-copies-"));
  const git = (cwd, ...a) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
  const repo = join(dir, "rome");
  const env = join(repo, "environments/slack-app");
  cpSync(envSrc, env, {
    recursive: true,
    filter: (p) => !/^\.state/.test(basename(p)),
  });
  git(dir, "init", "-q", "-b", "main", repo);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "c");
  const cloud = join(dir, "rome-cloud");
  mkdirSync(join(cloud, "webhook-relay"), { recursive: true });
  writeFileSync(join(cloud, "webhook-relay/.keep"), "");
  git(dir, "init", "-q", "-b", "main", cloud);
  git(cloud, "add", ".");
  git(cloud, "commit", "-q", "-m", "c");

  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls.jsonl");
  const psOut = join(dir, "ps.txt");
  writeFileSync(psOut, "");
  const stub = (name, body) => {
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env bash
"${process.execPath}" -e 'require("fs").appendFileSync(process.env.CALLS, JSON.stringify({cmd: process.argv[1], argv: process.argv.slice(2)}) + "\\n")' -- "${name}" "$@"
${body}
exit 0
`,
    );
    chmodSync(join(bin, name), 0o755);
  };
  // `docker ps` without -q prints what the test puts in ps.txt: other
  // projects' containers for up.sh's port check.
  stub("docker", `[ "$1" = ps ] && [[ " $* " != *" -aq "* ]] && cat "${psOut}"`);
  stub("curl", "");
  stub("pnpm", "mkdir -p node_modules/.bin && touch node_modules/.bin/tsx && chmod +x node_modules/.bin/tsx");

  const vars = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: calls,
    ROME_CLOUD_DIR: cloud,
  };
  delete vars.SLACKENV_PROJECT;
  delete vars.SLACKENV_PORT_BASE;
  const run = (script, args, extra = {}) =>
    spawnSync(join(env, script), args, { env: { ...vars, ...extra }, encoding: "utf8" });
  const readCalls = () =>
    readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const clearCalls = () => writeFileSync(calls, "");
  const envFile = (state) =>
    Object.fromEntries(
      readFileSync(join(state, "compose.env"), "utf8")
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  return { dir, env, run, readCalls, clearCalls, psOut, envFile };
}

const up = ["--cloud-only", "--rome", "HEAD", "--rome-cloud", "main"];

test("a named copy gets its own project, state folder and ports; the default keeps today's", () => {
  const t = setup();
  const def = t.run("up.sh", up);
  assert.equal(def.status, 0, def.stderr);
  const named = t.run("up.sh", ["--project", "ambient", "--port-base", "47300", ...up]);
  assert.equal(named.status, 0, named.stderr);

  const a = t.envFile(join(t.env, ".state"));
  assert.equal(a.SLACKENV_PROJECT, "slackenv");
  assert.deepEqual(
    [a.PANTHEON_PORT, a.ROME_A_PORT, a.ROME_B_PORT, a.BROWSER_PORT, a.MODEL_PROXY_HOST_PORT, a.SLACK_GATEWAY_PORT, a.FAKE_SLACK_PORT],
    ["47100", "47181", "47182", "47190", "47191", "47192", "47200"],
  );
  assert.match(a.ROME_IMAGE, /^slackenv-rome:/);
  const b = t.envFile(join(t.env, ".state-ambient"));
  assert.equal(b.SLACKENV_PROJECT, "ambient");
  assert.deepEqual(
    [b.PANTHEON_PORT, b.ROME_A_PORT, b.ROME_B_PORT, b.BROWSER_PORT, b.MODEL_PROXY_HOST_PORT, b.SLACK_GATEWAY_PORT, b.FAKE_SLACK_PORT],
    ["47300", "47381", "47382", "47390", "47391", "47392", "47400"],
  );
  assert.match(b.ROME_IMAGE, /^slackenv-ambient-rome:/);
  assert.equal(b.CLOUD_ORIGIN, "http://127.0.0.1:47300");

  const ctl = join(t.env, "ctl.sh");
  const jsonA = JSON.parse(readFileSync(join(t.env, ".state/env.json"), "utf8"));
  assert.deepEqual(jsonA.instances[0].control.stop, [ctl, "stop", "rome-a"]);
  assert.deepEqual(jsonA.down, [join(t.env, "down.sh")]);
  assert.equal(jsonA.fake_slack.control, "http://127.0.0.1:47200/_control");
  const jsonB = JSON.parse(readFileSync(join(t.env, ".state-ambient/env.json"), "utf8"));
  assert.deepEqual(jsonB.copy, {
    project: "ambient",
    port_base: 47300,
    state_dir: join(t.env, ".state-ambient"),
  });
  assert.deepEqual(jsonB.instances[0].control.stop, [ctl, "--project", "ambient", "stop", "rome-a"]);
  assert.deepEqual(jsonB.instances[0].control.logs, [ctl, "--project", "ambient", "logs", "rome-a"]);
  assert.equal(jsonB.instances[0].url, "http://127.0.0.1:47381");
  assert.equal(jsonB.fake_slack.control, "http://127.0.0.1:47400/_control");
  assert.deepEqual(jsonB.product_tests, [ctl, "--project", "ambient", "product-tests"]);
  assert.deepEqual(jsonB.down, [join(t.env, "down.sh"), "--project", "ambient"]);
  assert.equal(jsonB.repos.rome, join(t.env, ".state-ambient/rome-src"));
});

test("ctl.sh and down.sh of one copy touch only that copy", () => {
  const t = setup();
  assert.equal(t.run("up.sh", up).status, 0);
  assert.equal(t.run("up.sh", ["--project", "ambient", "--port-base", "47300", ...up]).status, 0);
  const stateA = join(t.env, ".state");
  const stateB = join(t.env, ".state-ambient");

  t.clearCalls();
  const logs = t.run("ctl.sh", ["--project", "ambient", "logs", "rome-a", "--since", "2026-11-24T00:00:00Z"]);
  assert.equal(logs.status, 0, logs.stderr);
  const [call] = t.readCalls();
  assert.deepEqual(call.argv.slice(0, 5), ["compose", "--env-file", join(stateB, "compose.env"), "-f", join(t.env, "compose.yml")]);
  assert.ok(call.argv.includes("--since") && call.argv.includes("2026-11-24T00:00:00Z"), JSON.stringify(call));

  t.clearCalls();
  const down = t.run("down.sh", ["--project", "ambient", "--images"]);
  assert.equal(down.status, 0, down.stderr);
  const text = JSON.stringify(t.readCalls());
  assert.ok(!text.includes(`${stateA}/`), text);
  assert.ok(!text.includes("project=slackenv"), text);
  assert.ok(text.includes("label=com.docker.compose.project=ambient"), text);
  assert.ok(!existsSync(stateB));
  assert.ok(existsSync(join(stateA, "compose.env")));
  assert.ok(existsSync(join(stateA, "rome-src/.git")));
});

test("up.sh refuses ports another compose project holds, before starting anything", () => {
  const t = setup();
  // Another copy's fake Slack (published) and browser (host network, --port).
  writeFileSync(
    t.psOut,
    [
      `slackenv\t127.0.0.1:47200->8080/tcp\t"node /env/fake-slack/server.mjs"`,
      `slackenv\t\t"/usr/bin/tini -- npx -y playwright@1.62.1 run-server --host 127.0.0.1 --port 47190"`,
      "",
    ].join("\n"),
  );
  t.clearCalls();
  const r = t.run("up.sh", ["--project", "ambient", ...up]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ports taken by another project: 47190 \(slackenv\), 47200 \(slackenv\)|47200 \(slackenv\), 47190 \(slackenv\)/);
  assert.ok(!t.readCalls().some((c) => c.argv.includes("up")), "nothing was started");
  // Its own containers do not count against it, and another base is free.
  assert.equal(t.run("up.sh", ["--project", "slackenv", "--port-base", "47100", ...up]).status, 0);
  assert.equal(t.run("up.sh", ["--project", "ambient", "--port-base", "47300", ...up]).status, 0);
  // live.sh's name is refused.
  assert.equal(t.run("up.sh", ["--project", "slackenv-live", ...up]).status, 2);
});

test("product-tests runs a file the commit lacks, placed where the commit has nothing", () => {
  const t = setup();
  assert.equal(t.run("up.sh", ["--project", "ambient", "--port-base", "47300", ...up]).status, 0);
  const extra = join(t.dir, "recall.test.ts");
  writeFileSync(extra, "// the verifier's own test\n");
  const dest = "packages/core/src/verifier/recall.test.ts";

  t.clearCalls();
  const r = t.run("ctl.sh", ["--project", "ambient", "product-tests", "--add", `${extra}=${dest}`]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const last = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(last.ok, true);
  assert.deepEqual(last.runs, [{ package: "packages/core", files: [dest], exit_code: 0 }]);
  const runs = t.readCalls().filter((c) => c.argv[0] === "run");
  assert.ok(runs.length >= 2, JSON.stringify(runs));
  for (const c of runs) {
    const i = c.argv.indexOf("-v");
    assert.equal(c.argv[i + 1], `${extra}:/repo/${dest}:ro`);
    assert.match(c.argv.find((a) => a.includes("-rome-test:")), /^slackenv-ambient-rome-test:/);
  }
  assert.ok(runs.at(-1).argv.includes(`/repo/${dest}`));

  // A path the commit has is never replaced.
  const clash = t.run("ctl.sh", ["--project", "ambient", "product-tests", "--add", `${extra}=environments/slack-app/up.sh`]);
  assert.equal(clash.status, 2);
  assert.match(clash.stdout, /already in the commit/);
});
