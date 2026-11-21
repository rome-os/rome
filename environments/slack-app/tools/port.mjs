// ctl.sh port: one call to the Slack app connection's own port, the one the
// connector app uses, made the way an agent makes it: through its
// execute_action tool, calling connector:connector_proxy with Slack's method,
// in a dashboard turn of the guardian's. The model proxy answers that turn
// itself (port-script.mjs), so the call is exactly the one asked for, made
// once, and its result comes back as Rome sent it. Test only: each call costs
// one dashboard chat, removed afterwards.
//
//   node port.mjs <op> '<json>' --instance <url> --cookies <file> --proxy <control url>
//
// Ops, each mapped to one Slack method on connector_proxy:
//   send {chat, text, thread?}   chat.postMessage {channel, text, thread_ts?}
//   read {chat, ...}             conversations.history {channel, ...}
//   thread {chat, ts, ...}       conversations.replies {channel, ts, ...}
//   groups {...}                 conversations.list {...}
//   call {method, args}          <method> args
// Prints the action's result as Rome returned it. A refusal prints
// {"refused": "<why>", "at": "connector" | "rome"} and exits 0: "connector"
// when the action ran and answered with an error, "rome" when Rome stopped the
// call before the action answered (an unknown action, an approval, a thrown
// error). A turn that made no call prints {"error": …} and exits 1.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const ACTION = "connector:connector_proxy";

const [op, raw, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, "")] = rest[i + 1];
const usage =
  "usage: port.mjs send|read|thread|groups|call '<json>' --instance <url> --cookies <file> --proxy <url>";
if (!flags.instance || !flags.cookies || !flags.proxy) fail(2, usage);
let given;
try {
  given = JSON.parse(raw ?? "{}");
} catch {
  fail(2, `the op's arguments must be a JSON object: ${raw}`);
}
if (!given || typeof given !== "object" || Array.isArray(given))
  fail(2, "the op's arguments must be a JSON object");

const jsonArgs = slackCall(op, given);
const timeoutS = Number(flags.timeout ?? process.env.SLACKENV_PORT_TIMEOUT_S ?? 180);
const cookies = JSON.parse(readFileSync(flags.cookies, "utf8"));
const headers = {
  cookie: Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; "),
  origin: flags.instance,
  "content-type": "application/json",
};

const nonce = randomBytes(12).toString("hex");
const started = Date.now();
await must(
  fetch(`${flags.proxy}/_port`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, action_name: ACTION, json_args: jsonArgs }),
  }),
  "the model proxy took no job (is it the isolated environment's?)",
);
const chat = await must(
  fetch(`${flags.instance}/api/chat/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agentName: "main", name: "slackenv port" }),
  }),
  "Rome opened no dashboard chat",
);
const chatId = chat.id ?? chat.session?.id;
let job;
try {
  await must(
    fetch(`${flags.instance}/api/chat/sessions/${encodeURIComponent(chatId)}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: `slackenv-port:${nonce}` }),
    }),
    "Rome took no message in the dashboard chat",
  );
  for (;;) {
    job = await fetch(`${flags.proxy}/_port/${nonce}`).then((r) => r.json());
    if (job.state === "done" || job.state === "failed") break;
    if (Date.now() - started > timeoutS * 1000) break;
    await new Promise((r) => setTimeout(r, 500));
  }
} finally {
  await fetch(`${flags.instance}/api/chat/sessions/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
    headers,
  }).catch(() => {});
  await fetch(`${flags.proxy}/_port/${nonce}`, { method: "DELETE" }).catch(() => {});
}

if (job?.state !== "done") {
  // Each model request the job saw and what it was given, so a fault reads itself.
  const seen = (job?.seen ?? [])
    .map(
      (r) =>
        `#${r.n} (${r.side ?? (r.execute_action ? "offers execute_action" : `${r.tools} tools`)}): ${r.given}`,
    )
    .join("; ");
  fail(
    1,
    job?.error ??
      `the turn made no call within ${timeoutS} s (job ${job?.state}; requests: ${seen || "none"})`,
    { job },
  );
}
const { text, is_error: isError } = job.result;
let out;
try {
  out = JSON.parse(text);
} catch {
  out = text;
}
if (isError) refused(typeof out === "string" ? out : text, "rome");
if (out && typeof out === "object" && (out.pendingApproval || out.pendingInteraction))
  refused(out.message ?? text, "rome");
if (out && typeof out === "object" && out.status === "error") {
  // Whether the action itself answered, from Rome's own record of what ran.
  const ran = await ranHere();
  refused(out.error ?? text, ran ? "connector" : "rome");
}
console.log(typeof out === "string" ? JSON.stringify({ text: out }) : JSON.stringify(out));

/** The connector_proxy call an op makes. */
function slackCall(op, a) {
  const { chat, ...more } = a;
  const call = (method, body) => ({
    toolkit: "slack",
    path: `/api/${method}`,
    method: "POST",
    body,
  });
  switch (op) {
    case "send": {
      const { text, thread, ...others } = more;
      if (typeof chat !== "string" || typeof text !== "string")
        fail(2, 'send takes {"chat", "text", "thread"?}');
      return call("chat.postMessage", {
        channel: chat,
        text,
        ...(thread !== undefined ? { thread_ts: thread } : {}),
        ...others,
      });
    }
    case "read":
      if (typeof chat !== "string") fail(2, 'read takes {"chat"}');
      return call("conversations.history", { channel: chat, ...more });
    case "thread":
      if (typeof chat !== "string" || typeof more.ts !== "string")
        fail(2, 'thread takes {"chat", "ts"}');
      return call("conversations.replies", { channel: chat, ...more });
    case "groups":
      return call("conversations.list", a);
    case "call":
      if (typeof a.method !== "string" || !/^[a-zA-Z.]+$/.test(a.method))
        fail(2, 'call takes {"method", "args"}');
      return call(a.method, a.args ?? {});
    default:
      return fail(2, usage);
  }
}

/** True when Rome recorded connector_proxy running with these arguments
 *  since this call began (GET /api/action-executions). */
async function ranHere() {
  const groups = await fetch(
    `${flags.instance}/api/action-executions?actionName=${encodeURIComponent(ACTION)}&limit=20`,
    { headers },
  )
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  return groups.some(({ rootExecution: e }) => {
    const at = new Date(e.createdAt ?? e.startedAt).getTime();
    const args = typeof e.args === "string" ? safeJson(e.args) : e.args;
    return at >= Math.floor(started / 1000) * 1000 - 1000 && isDeepStrictEqual(args, jsonArgs);
  });
}

async function must(pending, what) {
  let r;
  try {
    r = await pending;
  } catch (error) {
    fail(1, `${what}: ${error.message}`);
  }
  if (!r.ok) fail(1, `${what}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function refused(why, at) {
  console.log(JSON.stringify({ refused: why, at }));
  process.exit(0);
}

function fail(code, error, extra = {}) {
  console.log(JSON.stringify({ error, ...extra }));
  process.exit(code);
}
