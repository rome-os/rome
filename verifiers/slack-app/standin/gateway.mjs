// Stand-in for the slack-gateway Worker, with the parts of Rome Cloud and the
// relay it needs, in one server, for the Worker proof (prove-worker.mjs). It
// plays the Worker's contract as rome-cloud's docs/slack-gateway.md gives it:
// Slack's signature first, one workspace to one instance, the bot token kept
// here, a signed deposit into the instance's mailbox, and only the methods
// Rome's connection makes. Also a stand-in signer (`POST /token/<name>`), Rome
// Cloud's whoami and mailboxes, and the relay's deposit and an HTTP drain.
// `breaks` switches one promise off at a time (README.md, "Worker proof").

import { appendFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readBody, send, serve } from "./serve.mjs";

const rand = (n = 12) => randomBytes(n).toString("hex");
const hmac = (key, body) => createHmac("sha256", key).update(body).digest("hex");
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const METHODS = new Set(["chat.postMessage", "conversations.open", "conversations.history", "conversations.replies", "users.conversations", "users.info"]);

export async function startGateway({ slackUrl, clientId, clientSecret, signingSecret, shared, logFile, breaks }) {
  const instances = new Map(); // id -> {depositUrl, depositKey}
  const workspaces = new Map(); // team -> {instance, token, botUserId, name, boundAt}
  const mailboxes = new Map(); // id -> {drainKey, frames: [{seq, headers, body, at}], seq}
  const log = (o) => appendFileSync(logFile, `slack-gateway-1  | ${JSON.stringify(o)}\n`);
  let self;

  const instanceOf = (req) => /^Bearer jwt-(\w+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;

  async function slackApi(method, token, args, form) {
    const r = await fetch(`${slackUrl}/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
      },
      body: form ? new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(args),
    });
    return { status: r.status, text: await r.text(), retryAfter: r.headers.get("retry-after") };
  }

  function deposit(instanceId, raw, token) {
    const inst = instances.get(instanceId);
    const id = /\/h\/(\w+)\./.exec(inst?.depositUrl ?? "")?.[1];
    const box = mailboxes.get(id);
    if (!box) return false;
    const headers = { "x-rome-slack": "1", "x-rome-slack-signature": hmac(inst.depositKey, raw) };
    // Broken W-R15-deposit hands the token on with the event.
    if (breaks.has("W-R15-deposit")) headers["x-slack-bot-token"] = token;
    box.frames.push({ seq: ++box.seq, headers, body: Buffer.from(raw).toString("base64"), at: Date.now() });
    return true;
  }

  /** Trades Slack's code for the workspace's token and binds it to `instanceId`. */
  async function bind(code, instanceId) {
    const r = await fetch(`${slackUrl}/api/oauth.v2.access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${self.url}/api/slack/callback` }).toString(),
    });
    const data = await r.json().catch(() => null);
    if (!data?.ok || !data.access_token) return { status: 400, body: { error: "code_rejected", slack: data?.error ?? null } };
    const team = data.team?.id;
    const held = workspaces.get(team);
    // Broken W-R3-takeover lets a second instance take a bound workspace.
    if (held && held.instance !== instanceId && !breaks.has("W-R3-takeover")) return { status: 409, body: { error: "workspace_bound", teamName: data.team?.name ?? "" } };
    workspaces.set(team, { instance: instanceId, token: data.access_token, botUserId: data.bot_user_id, name: data.team?.name ?? "", boundAt: Date.now() });
    // Broken W-R15-log logs the token.
    log({ event: "slack_bound", teamId: team, ...(breaks.has("W-R15-log") ? { token: data.access_token } : {}) });
    return { status: 200, body: { teamId: team, teamName: data.team?.name ?? "" } };
  }

  self = await serve(async (req, res, url) => {
    const p = url.pathname;
    // The stand-in signer: a fresh instance JWT for instance `name`.
    const signer = /^\/token\/(\w+)$/.exec(p);
    if (signer && req.method === "POST") return send(res, 200, { token: `jwt-${signer[1]}` });

    // Rome Cloud: who the instance is, and a relay mailbox for it.
    if (p === "/api/instance/whoami") {
      const who = instanceOf(req);
      return who ? send(res, 200, { instanceId: `inst-${who}`, account: { id: `acct-${who}` } }) : send(res, 401, { error: "unauthorized" });
    }
    if (p === "/api/relay/mailboxes" && req.method === "POST") {
      const who = instanceOf(req);
      if (!who) return send(res, 401, { error: "unauthorized" });
      const id = rand(6);
      const drainKey = rand();
      mailboxes.set(id, { drainKey, frames: [], seq: 0 });
      return send(res, 200, { depositUrl: `${self.url}/h/${id}.${rand(4)}`, drainKey, connectUrl: `${self.url}/c/${id}` });
    }
    // The relay: frames waiting until acknowledged. Broken W-R6-expire drops
    // a frame left 20 s unacknowledged.
    const c = /^\/c\/(\w+)\/(frames|ack)$/.exec(p);
    if (c) {
      const box = mailboxes.get(c[1]);
      if (!box || req.headers.authorization !== `Bearer ${box.drainKey}`) return send(res, 401, { error: "unauthorized" });
      if (breaks.has("W-R6-expire")) box.frames = box.frames.filter((f) => Date.now() - f.at < 20_000);
      if (c[2] === "frames") return send(res, 200, { frames: box.frames.map(({ seq, headers, body }) => ({ type: "event", seq, headers, body })) });
      const { seq } = JSON.parse((await readBody(req)) || "{}");
      box.frames = box.frames.filter((f) => f.seq !== seq);
      return send(res, 200, { ok: true });
    }

    // The Worker.
    if (p === "/health") return send(res, 200, { ok: true, service: "slack-gateway" });
    if (p === "/slack/events" && req.method === "POST") {
      const raw = await readBody(req);
      const ts = req.headers["x-slack-request-timestamp"];
      const sig = String(req.headers["x-slack-signature"] ?? "");
      const signed = ts && Math.abs(Date.now() / 1000 - Number(ts)) <= 300 && same(sig, `v0=${hmac(signingSecret, `v0:${ts}:${raw}`)}`);
      // Broken W-R7-signature takes any event.
      if (!signed && !breaks.has("W-R7-signature")) {
        log({ event: "slack_event_bad_signature" });
        return send(res, 401, { error: "invalid_signature" });
      }
      const env = JSON.parse(raw);
      if (env.type === "url_verification") return send(res, 200, { challenge: env.challenge });
      const ws = workspaces.get(env.team_id);
      const type = env.event?.type;
      if (ws && (type === "app_uninstalled" || (type === "tokens_revoked" && env.event?.tokens?.bot?.length)) && !breaks.has("W-R8-uninstall")) {
        workspaces.delete(env.team_id);
        log({ event: "slack_workspace_removed", teamId: env.team_id });
      }
      if (!ws) return send(res, 200, { ok: true });
      // Broken W-R4-drop answers every fourth event without depositing it.
      self.events = (self.events ?? 0) + 1;
      if (breaks.has("W-R4-drop") && self.events % 4 === 0) return send(res, 200, { ok: true });
      let body = raw;
      // Broken W-R5-thread loses a mention's thread.
      if (breaks.has("W-R5-thread") && type === "app_mention" && env.event.thread_ts) {
        delete env.event.thread_ts;
        body = JSON.stringify(env);
      }
      // Broken W-R7-route deposits into every connected instance's mailbox.
      const to = breaks.has("W-R7-route") ? [...instances.keys()] : [ws.instance];
      let ok = true;
      for (const i of to) ok = deposit(i, body, ws.token) && ok;
      return ok ? send(res, 200, { ok: true }) : send(res, 500, { error: "deposit_failed" });
    }
    // Rome Cloud: the install link, and the callback that binds as the
    // signed-in guardian, as Rome Cloud's own pages do.
    if (p === "/api/instance/slack/install-url" && req.method === "POST") {
      const who = instanceOf(req);
      if (!who) return send(res, 401, { error: "unauthorized" });
      const q = new URLSearchParams({ client_id: clientId, scope: "chat:write,im:history,app_mentions:read", redirect_uri: `${self.url}/api/slack/callback`, state: `inst-${who}` });
      return send(res, 200, { url: `${slackUrl}/oauth/v2/authorize?${q}` });
    }
    if (p === "/api/slack/callback") {
      const instanceId = url.searchParams.get("state");
      const signedIn = /session=guardian-(\w+)/.exec(req.headers.cookie ?? "")?.[1];
      if (!signedIn || `inst-${signedIn}` !== instanceId) return send(res, 403, "<h1>Sign in to Rome Cloud</h1>", "text/html");
      const r = await bind(url.searchParams.get("code"), instanceId);
      const page = r.status === 200 ? `Connected to ${r.body.teamName}` : r.status === 409 ? "Already connected to another Rome" : "Try again";
      return send(res, r.status === 200 || r.status === 409 ? r.status : 400, `<h1>${page}</h1>`, "text/html");
    }
    if (p === "/internal/bind" && req.method === "POST") {
      if (req.headers.authorization !== `Bearer ${shared}`) return send(res, 401, { error: "unauthorized" });
      const { code, instanceId } = JSON.parse((await readBody(req)) || "{}");
      const r = await bind(code, instanceId);
      return send(res, r.status, r.body);
    }
    const who = instanceOf(req);
    const instanceId = who ? `inst-${who}` : null;
    const listed = () =>
      [...workspaces.entries()]
        .filter(([, w]) => w.instance === instanceId)
        .map(([teamId, w]) => ({ teamId, teamName: w.name, botUserId: w.botUserId, boundAt: w.boundAt, ...(breaks.has("W-R15-token") ? { botToken: w.token } : {}) }));
    if (p === "/v1/connect" || p === "/v1/workspaces" || p.startsWith("/v1/slack/")) {
      if (!instanceId) return send(res, 401, { error: "invalid_token" });
      if (p === "/v1/connect" && req.method === "POST") {
        const { depositUrl } = JSON.parse((await readBody(req)) || "{}");
        const had = instances.get(instanceId);
        instances.set(instanceId, { depositUrl, depositKey: had?.depositKey ?? rand(32) });
        return send(res, 200, { depositKey: instances.get(instanceId).depositKey, workspaces: listed() });
      }
      if (p === "/v1/connect" && req.method === "DELETE") {
        const released = [];
        for (const [team, w] of workspaces) {
          if (w.instance !== instanceId) continue;
          // Broken W-R8-keep-token never revokes; W-R8-held keeps the workspace bound.
          if (!breaks.has("W-R8-keep-token")) await slackApi("auth.revoke", w.token, {}, true);
          if (!breaks.has("W-R8-held")) workspaces.delete(team);
          released.push(team);
        }
        instances.delete(instanceId);
        return send(res, 200, { released });
      }
      if (p === "/v1/workspaces") return send(res, 200, { workspaces: listed() });
      const method = p.slice("/v1/slack/".length);
      // Broken W-R9-any passes any method on.
      if (!METHODS.has(method) && !breaks.has("W-R9-any")) return send(res, 403, { error: "method_not_allowed", allowed: [...METHODS] });
      const team = req.headers["x-slack-team"];
      const ws = workspaces.get(team);
      // Broken W-R15-cross acts for any instance in a bound workspace.
      if (!ws || (ws.instance !== instanceId && !breaks.has("W-R15-cross"))) return send(res, 403, { error: "not_bound" });
      const args = JSON.parse((await readBody(req)) || "{}");
      const form = !["chat.postMessage", "conversations.open"].includes(method);
      const r = await slackApi(method, ws.token, args, form);
      res.writeHead(r.status, { "content-type": "application/json", ...(r.retryAfter ? { "retry-after": r.retryAfter } : {}) });
      return res.end(r.text);
    }
    return send(res, 404, { error: "not_found" });
  });
  return self;
}
