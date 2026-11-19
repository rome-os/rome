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
    inst.connect.grant ??= "default";
    inst.messagesPath ??= null;
  }
  env.stopSeconds ??= 3600;
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
    repos: raw.repos,
    slack: { control: raw.fake_slack?.control },
    instances: (raw.instances ?? []).map((i) => ({
      name: i.name,
      api: i.url ? `${i.url}/api` : undefined,
      headers: cookie(i.guardian_cookies_file),
      control: { stop: i.stop, start: i.start },
      connect: i.connect,
      messagesPath: i.messages_path,
    })),
  };
}
