// Reads env.json and fills the defaults this verifier assumes. Takes the
// environment's own shape (environments/slack-app/tools/write-env-json.mjs,
// `version: 1`) or the stand-in's (../CONTRACT.md) and returns the latter.

import { existsSync, readFileSync } from "node:fs";

/** Reads and checks env.json at `path`. Throws with every missing field named. */
export function loadEnv(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const env = raw.version === 1 ? fromEnvironment(raw) : raw;
  const missing = [];
  const need = (cond, what) => {
    if (!cond) missing.push(what);
  };
  need(env.commits?.rome, "commits.rome");
  need(env.commits?.romeCloud, "commits.romeCloud");
  need(env.commits?.environment, "commits.environment");
  need(env.model, "model");
  need(env.slack?.control, "slack.control");
  need(Array.isArray(env.instances) && env.instances.length >= 2, "instances (2)");
  for (const [i, inst] of (env.instances ?? []).entries()) {
    need(inst.api, `instances[${i}].api`);
    need(inst.control?.stop, `instances[${i}].control.stop`);
    need(inst.control?.start, `instances[${i}].control.start`);
  }
  if (missing.length) throw new Error(`env.json is missing: ${missing.join(", ")}`);

  for (const inst of env.instances) {
    inst.headers ??= {};
    inst.connect ??= {};
    inst.connect.kind ??= "slack_app";
    inst.connect.grant ??= "bot";
  }
  // R6's stop: VERIFIER_R6_STOP_SECONDS (run.sh --r6-stop) wins, then
  // env.json, then a quick 120 s. Production's stop is 3600 s.
  const stop = Number(process.env.VERIFIER_R6_STOP_SECONDS);
  if (process.env.VERIFIER_R6_STOP_SECONDS && !(stop > 0))
    throw new Error(`VERIFIER_R6_STOP_SECONDS must be a positive number of seconds`);
  if (stop > 0) env.stopSeconds = stop;
  env.stopSeconds ??= 120;
  // R12's mode: allowMembers turns replies to other members on first
  // (VERIFIER_R12_ALLOW_MEMBERS=1, run.sh --r12-allow-members), else the
  // instance's default is scored as it is.
  env.r12 ??= {};
  const allow = process.env.VERIFIER_R12_ALLOW_MEMBERS;
  if (allow !== undefined && allow !== "") env.r12.allowMembers = /^(1|true|yes|on)$/i.test(allow);
  env.r12.allowMembers ??= false;
  env.timeouts ??= {};
  env.timeouts.replySeconds ??= 90;
  env.timeouts.settleSeconds ??= 10;
  env.timeouts.restartSeconds ??= 300;
  // The environment does not name its checkouts yet, so R11 can take them
  // from the shell.
  env.repos ??= {};
  env.repos.rome ??= process.env.VERIFIER_ROME_DIR;
  env.repos.romeCloud ??= process.env.VERIFIER_ROME_CLOUD_DIR;
  env.repos.romeCloudBase ??= process.env.VERIFIER_ROME_CLOUD_BASE ?? "origin/main";
  env.repos.romeBase ??= process.env.VERIFIER_ROME_BASE ?? "origin/main";
  return env;
}

function fromEnvironment(raw) {
  const cookie = (file) => {
    if (!file || !existsSync(file)) return {};
    const map = JSON.parse(readFileSync(file, "utf8"));
    return {
      cookie: Object.entries(map)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    };
  };
  return {
    commits: {
      rome: raw.commits?.rome,
      romeCloud: raw.commits?.rome_cloud,
      environment: raw.commits?.environment,
    },
    model: raw.agent?.model,
    differences: raw.differences,
    stopSeconds: raw.shortened?.r6_stop_minutes ? raw.shortened.r6_stop_minutes * 60 : undefined,
    repos: raw.repos && {
      rome: raw.repos.rome,
      romeCloud: raw.repos.romeCloud ?? raw.repos.rome_cloud,
      romeCloudBase:
        raw.repos.romeCloudBase ?? raw.repos.rome_cloud_base_ref ?? raw.repos.rome_cloud_base,
      romeBase: raw.repos.romeBase ?? raw.repos.rome_base_ref,
      romeDependencies: raw.repos.rome_dependencies,
    },
    slack: { control: raw.fake_slack?.control },
    romeCloud: { query: raw.rome_cloud?.query },
    instances: (raw.instances ?? []).map((i) => ({
      name: i.name,
      api: i.url ? `${i.url}/api` : undefined,
      headers: cookie(i.guardian_cookies_file),
      control: {
        stop: i.stop,
        start: i.start,
        wipeChat: i.control?.wipe_chat ?? i.wipe_chat,
      },
      connect: i.connect,
    })),
  };
}
