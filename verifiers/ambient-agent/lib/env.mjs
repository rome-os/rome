// Reads the environment's env.json (`version: 1`, written by
// environments/slack-app/tools/write-env-json.mjs) into the few things this
// verifier uses. Every address and control comes from it, never a constant.

import { readFileSync } from "node:fs";

/**
 * Reads env.json at `path` for the instance named `instanceName` (default the
 * first). The instance's workspace is the one at the same index, as up.sh
 * signs rome-a in to the first workspace and rome-b to the second. Throws with
 * every missing field named.
 */
export function loadEnv(path, instanceName) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const missing = [];
  const need = (value, what) => {
    if (value === undefined || value === null || value === "") missing.push(what);
    return value;
  };
  const instances = raw.instances ?? [];
  const index = instanceName ? instances.findIndex((i) => i.name === instanceName) : 0;
  if (index < 0) throw new Error(`env.json names no instance ${instanceName}`);
  const inst = instances[index] ?? {};
  const ws = raw.fake_slack?.workspaces?.[index] ?? {};
  const control = inst.control ?? {};
  // ctl.sh's own subcommands sit where its stop command says "stop":
  // [ctl, ...flags, "stop", name].
  const stop = control.stop ?? inst.stop;
  const beside = (sub) => {
    const at = Array.isArray(stop) ? stop.lastIndexOf("stop") : -1;
    return at > 0 ? [...stop.slice(0, at), sub, ...stop.slice(at + 1)] : undefined;
  };
  const limit = raw.fake_slack?.history_limit ?? {};
  const env = {
    path,
    commits: {
      product: need(raw.commits?.rome, "commits.rome"),
      productRef: raw.commits?.rome_ref ?? null,
      environment: need(raw.commits?.environment, "commits.environment"),
    },
    model: need(raw.agent?.model, "agent.model"),
    effort: raw.agent?.effort ?? null,
    // The model proxy's count of tokens and cost for a time span, when the
    // environment offers one: an argv that takes --since and --until.
    cost: raw.agent?.model_proxy?.usage_command ?? null,
    control: need(raw.fake_slack?.control, "fake_slack.control"),
    // Slack's history limit as the environment states it. The verifier paces
    // its mentions by it and never turns it off.
    historyLimit: {
      on: limit.on !== false,
      windowMs: limit.window_ms ?? Math.round(60_000 / (limit.requests_per_minute || 1)),
      maxMessages: limit.max_messages ?? 15,
    },
    workspace: {
      id: need(ws.id, `fake_slack.workspaces[${index}].id`),
      guardian: ws.guardian ?? null,
    },
    instance: {
      name: need(inst.name, `instances[${index}].name`),
      url: inst.url ?? null,
      stop: need(stop, `instances[${index}].control.stop`),
      start: need(control.start ?? inst.start, `instances[${index}].control.start`),
      status: need(
        control.status ?? inst.status ?? beside("status"),
        `instances[${index}].control.status`,
      ),
      logs: control.logs ?? beside("logs") ?? null,
    },
    rome: raw.repos?.rome ?? null,
    // The environment's runner of the product's tests, and its flag that
    // places a file the commit does not have: `<flag> <host file>=<path>`.
    productTests:
      raw.product_tests && raw.product_tests_add_flag
        ? { argv: raw.product_tests, addFlag: raw.product_tests_add_flag }
        : null,
  };
  if (missing.length) throw new Error(`env.json is missing: ${missing.join(", ")}`);
  return env;
}
