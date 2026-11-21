// The verifier's stand-in instance for the slack-gateway Worker: one call to
// the Worker (or Rome Cloud, or the instance's relay mailbox) as an instance,
// per run, printing one JSON object. The environment runs it as rome-a or
// rome-b (`ctl.sh as-instance <instance> agent.mjs <op> '<json>'`), in the
// instance's network with its signer, so the instance JWT never leaves it.
// Self-contained: it imports nothing of the verifier.
//
//   connect     {mailbox?}               POST /v1/connect, with a new relay
//                                        mailbox unless one is given
//   disconnect  {}                       DELETE /v1/connect
//   workspaces  {}                       GET /v1/workspaces
//   call        {team?, method, args}    POST /v1/slack/<method> (x-slack-team: team)
//   bind        {team, user}             the approve screen as the member, then
//                                        Rome Cloud's bind (GATEWAY_SHARED_SECRET)
//   deposit     {url, body, signature?}  POST a delivery into a mailbox
//   drain       {mailbox, depositKey, ms?, until?, ack?}
//                                        reads the mailbox for `ms`, or until
//                                        `until` event ids are seen; each frame
//                                        with its body and whether the deposit
//                                        key signs it
//
// Every answer carries `status` and `body` as the Worker gave them, so the
// verifier sees exactly what an instance would. Settings come from flags or
// the environment (SLACKENV_ first, as ctl.sh as-instance sets them): GATEWAY (https://slack.romeos.io), CLOUD
// (https://cloud.slackenv.test), SLACK (the fake Slack's control origin),
// SIGNER_SOCKET (/run/rome-signer/signer.sock), or ROME_INSTANCE_TOKEN_URL for
// the proof's stand-in signer.

import { createHmac, timingSafeEqual } from "node:crypto";
import { request } from "node:http";

const [op, raw = "{}", ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, "")] = rest[i + 1];
// The environment's as-instance sets SLACKENV_*; the proof's stand-in sets the bare names.
const setting = (name, fallback) => flags[name.toLowerCase()] ?? process.env[`SLACKENV_${name}`] ?? process.env[name] ?? fallback;
const gateway = setting("GATEWAY", "https://slack.romeos.io");
const cloud = setting("CLOUD", "https://cloud.slackenv.test");
const slack = setting("SLACK", "http://127.0.0.1:47200");
const socketPath = setting("SIGNER_SOCKET", "/run/rome-signer/signer.sock");
const tokenUrl = setting("ROME_INSTANCE_TOKEN_URL", null);

let args;
try {
  args = JSON.parse(raw);
} catch {
  done({ error: `the op's arguments must be JSON: ${raw}` }, 2);
}

function done(out, code = 0) {
  console.log(JSON.stringify(out));
  process.exit(code);
}

/** A fresh instance JWT, as Rome gets one: from the signer, or the proof's stand-in. */
async function instanceToken() {
  if (tokenUrl) {
    const r = await fetch(tokenUrl, { method: "POST" });
    const token = (await r.json().catch(() => ({}))).token;
    if (!token) throw new Error(`the stand-in signer answered ${r.status}`);
    return token;
  }
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/v1/token", method: "POST" }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        const token = JSON.parse(body || "{}").token;
        token ? resolve(token) : reject(new Error(`signer answered ${res.statusCode}: ${body}`));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** One HTTP call; never throws. */
async function call(url, init = {}) {
  try {
    const r = await fetch(url, { redirect: "manual", ...init });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 2000);
    }
    return { status: r.status, body, location: r.headers.get("location"), retryAfter: r.headers.get("retry-after") };
  } catch (error) {
    return { status: 0, body: String(error.cause?.message ?? error.message) };
  }
}
const jsonInit = (method, body, headers = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const asInstance = async (method, body, headers = {}) =>
  jsonInit(method, body, { authorization: `Bearer ${await instanceToken()}`, ...headers });

switch (op) {
  case "connect": {
    let mailbox = args.mailbox;
    if (!mailbox) {
      const m = await call(`${cloud}/api/relay/mailboxes`, await asInstance("POST", {}));
      if (!m.body?.depositUrl) done({ step: "mailbox", status: m.status, body: m.body }, 1);
      mailbox = m.body;
    }
    const who = await call(`${cloud}/api/instance/whoami`, { headers: { authorization: `Bearer ${await instanceToken()}` } });
    const r = await call(`${gateway}/v1/connect`, await asInstance("POST", { depositUrl: mailbox.depositUrl }));
    done({ status: r.status, body: r.body, mailbox, instanceId: who.body?.instanceId ?? null, accountId: who.body?.account?.id ?? null });
    break;
  }
  case "disconnect":
    done(await call(`${gateway}/v1/connect`, await asInstance("DELETE")));
    break;
  case "workspaces":
    done(await call(`${gateway}/v1/workspaces`, { headers: { authorization: `Bearer ${await instanceToken()}` } }));
    break;
  case "call":
    done(
      await call(
        `${gateway}/v1/slack/${args.method}`,
        await asInstance("POST", args.args ?? {}, args.team ? { "x-slack-team": args.team } : {}),
      ),
    );
    break;
  case "bind": {
    const who = await call(`${cloud}/api/instance/whoami`, { headers: { authorization: `Bearer ${await instanceToken()}` } });
    const instanceId = who.body?.instanceId;
    const accountId = who.body?.account?.id;
    if (!instanceId || !accountId) done({ step: "whoami", status: who.status, body: who.body }, 1);
    await call(`${slack}/_control/sign-in`, jsonInit("POST", { team: args.team, user: args.user }));
    const session = setting("CLOUD_COOKIES", null) ?? setting("CLOUD_SESSION", null);
    if (session) done({ ...(await bindThroughCloud(session)), instanceId, via: "Rome Cloud's callback" });
    const shared = process.env.GATEWAY_SHARED_SECRET ?? "";
    if (!shared) done({ step: "secret", error: "neither a Rome Cloud session (SLACKENV_CLOUD_COOKIES) nor GATEWAY_SHARED_SECRET is set" }, 1);
    const state = await call(`${slack}/_control/state`);
    const { code } = await approve({
      client_id: state.body?.app?.client_id ?? "",
      scope:
        args.scope ??
        "app_mentions:read,channels:history,channels:read,chat:write,groups:history,groups:read,im:history,im:read,im:write,users:read",
      redirect_uri: `${cloud}/api/slack/callback`,
      state: "verifier",
    });
    const r = await call(`${gateway}/internal/bind`, jsonInit("POST", { code, accountId, instanceId }, { authorization: `Bearer ${shared}` }));
    done({ ...r, instanceId, via: "the Worker's /internal/bind" });
    break;
  }
  case "deposit": {
    // R7: a delivery into a mailbox, as anyone holding its address could
    // send one: Slack's body with x-rome-slack, and the signature given (none
    // when absent).
    const headers = { "content-type": "application/json", "x-rome-slack": "1" };
    if (args.signature !== undefined) headers["x-rome-slack-signature"] = args.signature;
    done(await call(args.url, { method: "POST", headers, body: args.body }));
    break;
  }
  case "drain":
    done({ frames: await drain(args) });
    break;
  default:
    done({ error: `no op ${op}` }, 2);
}

/** Slack's approve screen as the signed-in member, with `params` from the link, at `origin`; the code. */
async function approve(params, origin = slack) {
  const form = new URLSearchParams({ ...params, team: args.team, user: args.user, decision: "allow" });
  if (args.scope) form.set("scope", args.scope);
  const approved = await call(`${origin}/oauth/v2/authorize/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const code = approved.location ? new URL(approved.location).searchParams.get("code") : null;
  if (!code) done({ step: "approve", status: approved.status, body: approved.body }, 1);
  return { code, location: approved.location };
}

/**
 * The real path: Rome Cloud's install link, Slack's approve screen, then
 * Rome Cloud's callback as the guardian signed in to Rome Cloud (a cookie
 * header, or a JSON map of cookies, in `file`). Answers as /internal/bind
 * would: 200 {teamId} once the Worker holds the workspace for this instance,
 * 409 {error} when the page says it is connected elsewhere, else 400.
 */
async function bindThroughCloud(file) {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(file, "utf8").trim();
  let cookie = text;
  try {
    cookie = Object.entries(JSON.parse(text)).map(([k, v]) => `${k}=${v}`).join("; ");
  } catch {}
  const link = await call(`${cloud}/api/instance/slack/install-url`, await asInstance("POST", {}));
  if (!link.body?.url) done({ step: "install-url", status: link.status, body: link.body }, 1);
  const params = Object.fromEntries(new URL(link.body.url).searchParams);
  const { location } = await approve(params, new URL(link.body.url).origin);
  const page = await call(location, { headers: { cookie } });
  const listed = await call(`${gateway}/v1/workspaces`, { headers: { authorization: `Bearer ${await instanceToken()}` } });
  const held = (listed.body?.workspaces ?? []).some((w) => w.teamId === args.team);
  const words = typeof page.body === "string" ? page.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300) : JSON.stringify(page.body).slice(0, 300);
  if (held) return { status: 200, body: { teamId: args.team }, page: { status: page.status, words } };
  if (page.status === 409 || /already connected/i.test(words)) return { status: 409, body: { error: "workspace_bound", page: words } };
  return { status: 400, body: { error: "not_bound", page: words, pageStatus: page.status } };
}

/** What one mailbox frame carried, and whether the deposit key signs its body. */
function frameOf(frame, depositKey) {
  const headers = Object.fromEntries(Object.entries(frame.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = frame.body ? Buffer.from(frame.body, "base64") : Buffer.alloc(0);
  const expected = createHmac("sha256", depositKey ?? "").update(body).digest("hex");
  const given = String(headers["x-rome-slack-signature"] ?? "");
  let parsed = null;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {}
  return {
    seq: frame.seq,
    eventId: parsed?.event_id ?? null,
    team: parsed?.team_id ?? null,
    type: parsed?.event?.type ?? null,
    channel: parsed?.event?.channel ?? null,
    text: parsed?.event?.text ?? null,
    slackHeader: headers["x-rome-slack"] ?? null,
    signed: given.length === expected.length && given.length > 0 && timingSafeEqual(Buffer.from(given), Buffer.from(expected)),
    headers,
    body: body.toString("utf8"),
  };
}

/**
 * Reads the mailbox for `ms` (default 10 s), or until every id in `until` is
 * seen, acknowledging each frame unless `ack` is false. The relay's drain is a
 * WebSocket; the proof's stand-in relay answers the same frames over HTTP.
 */
async function drain({ mailbox, depositKey, ms = 10_000, until = [], ack = true }) {
  const url = mailbox.connectUrl ?? mailbox.depositUrl.replace(/^http/, "ws").replace("/h/", "/c/").replace(/\.[^.]+$/, "");
  const want = new Set(until);
  const seen = [];
  if (/^https?:/.test(url)) {
    const auth = { authorization: `Bearer ${mailbox.drainKey}` };
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await call(`${url}/frames`, { headers: auth });
      for (const f of r.body?.frames ?? []) {
        const one = frameOf(f, depositKey);
        seen.push(one);
        want.delete(one.eventId);
        if (ack) await call(`${url}/ack`, jsonInit("POST", { seq: f.seq }, auth));
      }
      if (until.length && !want.size) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    return seen;
  }
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${mailbox.drainKey}` } });
    const finish = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(seen);
    };
    const timer = setTimeout(finish, ms);
    ws.addEventListener("error", finish);
    ws.addEventListener("message", (m) => {
      const frame = JSON.parse(String(m.data));
      if (frame.type !== "event") return;
      const one = frameOf(frame, depositKey);
      seen.push(one);
      want.delete(one.eventId);
      if (ack) ws.send(JSON.stringify({ type: "ack", seq: frame.seq }));
      if (until.length && !want.size) finish();
    });
  });
}
