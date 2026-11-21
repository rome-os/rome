// The verifier's stand-in instance for the slack-gateway Worker
// (gateway/agent.mjs), run as one instance through the environment's
// `as_instance` control: an argv prefix, or a shell command, to which the
// agent's path, the op and its JSON are appended. Every answer is kept, so
// R15 can search everything the Worker sent the instance.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const AGENT = fileURLToPath(new URL("../gateway/agent.mjs", import.meta.url));

function run(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 64 << 20, ...opts }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
  });
}

/** The last JSON object a command printed, or null. */
function lastJson(stdout) {
  for (const line of stdout.trim().split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

/**
 * One instance as the Worker sees it. `name` is the instance's name, and
 * `target` the environment's as_instance control for it.
 */
export function gatewayInstance(name, target) {
  const answers = [];
  const inst = {
    name,
    /** Every answer the Worker, Rome Cloud or the mailbox gave this instance, in order. */
    answers,
    mailbox: null,
    depositKey: null,
    instanceId: null,
    /** Frames drained from this instance's mailbox so far. */
    frames: [],
    /** One op of the agent; throws when the agent printed nothing it could read. */
    async op(op, args = {}) {
      const tail = [AGENT, op, JSON.stringify(args)];
      const r = Array.isArray(target)
        ? await run(target[0], [...target.slice(1), ...tail], { timeout: 600_000 })
        : await run("sh", ["-c", `${target} "$@"`, "as-instance", ...tail], { timeout: 600_000 });
      const out = lastJson(r.stdout);
      if (!out) throw new Error(`as-instance ${name} ${op}: exit ${r.code}, no JSON: ${(r.stdout + r.stderr).slice(-600)}`);
      answers.push({ op, args: op === "drain" ? { ms: args.ms, until: args.until?.length } : args, out });
      return out;
    },
    /** Connects to the Worker with this instance's mailbox (made on the first connect). */
    async connect() {
      const out = await inst.op("connect", inst.mailbox ? { mailbox: inst.mailbox } : {});
      if (out.status === 200) {
        inst.mailbox = out.mailbox;
        inst.depositKey = out.body?.depositKey ?? inst.depositKey;
        inst.instanceId = out.instanceId ?? inst.instanceId;
      }
      return out;
    },
    /** Drains the mailbox for `ms`, or until every id in `until` is in; keeps every frame. */
    async drain({ ms = 10_000, until = [] } = {}) {
      if (!inst.mailbox) return [];
      const out = await inst.op("drain", { mailbox: inst.mailbox, depositKey: inst.depositKey, ms, until });
      const frames = out.frames ?? [];
      inst.frames.push(...frames);
      return frames;
    },
  };
  return inst;
}
