// Reads the environment's env.json and fills the defaults this verifier
// assumes. The shape is in ../CONTRACT.md.

import { readFileSync } from "node:fs";

/** Reads and checks env.json at `path`. Throws with every missing field named. */
export function loadEnv(path) {
  const env = JSON.parse(readFileSync(path, "utf8"));
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
    inst.connect.kind ??= "slack";
    inst.connect.grant ??= "default";
    inst.messagesPath ??= null;
  }
  env.stopSeconds ??= 3600;
  env.timeouts ??= {};
  env.timeouts.replySeconds ??= 90;
  env.timeouts.settleSeconds ??= 10;
  env.timeouts.restartSeconds ??= 300;
  env.repos ??= {};
  env.repos.romeCloudBase ??= "origin/main";
  return env;
}
