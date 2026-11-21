// ctl.sh gateway-probe: proves the slack-gateway Worker in the stack, as one
// Rome instance, with no Rome code on the Worker's contract yet. It runs in the
// instance's network with the instance's signer socket, and checks, in order:
//
//   pinned     every container of the stack resolves slack.romeos.io inside
//              the stack only (ctl.sh checks it and passes --resolution)
//   health     GET /health answers {ok: true, service: "slack-gateway"}
//   refused    POST /v1/slack/auth.test, a method Rome's connection does not
//              make, twice on the same key (Rome Cloud checks the first, the
//              Worker's cache the second): 403 method_not_allowed both times,
//              and the fake Slack saw no auth.test call
//   connect    POST /v1/connect with the instance's own relay mailbox (from
//              Rome Cloud's POST /api/relay/mailboxes) answers a deposit key
//   bind       the fake Slack's approve screen gives a code, and Rome Cloud's
//              shared secret binds the workspace to the instance at
//              /internal/bind
//   event      a direct message in the fake Slack is sent, signed, to the
//              Worker, which answers 200
//   mailbox    that event is in the instance's mailbox, with x-rome-slack: 1
//              and an x-rome-slack-signature the deposit key verifies
//   cached     users.info for the member, twice on the cached key, answers
//              Slack's ok both times, each one call at the fake Slack
//
// It drains the mailbox and acknowledges what it finds, so a running instance
// may take the event first; the mailbox check then says so.
//
// Usage: node gateway-probe.mjs --team T --user U --text '...'
//          [--gateway https://slack.romeos.io] [--cloud https://127.0.0.1:47100]
//          [--slack http://127.0.0.1:47200] [--socket /run/rome-signer/signer.sock]
//          [--resolution '{"ok":…, …}']
// --cloud is Rome Cloud's origin, the one its signers name as audience.
// GATEWAY_SHARED_SECRET comes from the environment. Prints one JSON object;
// exit 0 when every check passed.

import { createHmac, timingSafeEqual } from "node:crypto";
import { request } from "node:http";

const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) flags[argv[i].replace(/^--/, "")] = argv[i + 1];
const gateway = flags.gateway ?? "https://slack.romeos.io";
const cloud = flags.cloud ?? "https://127.0.0.1:47100";
const slack = flags.slack ?? "http://127.0.0.1:47200";
const socketPath = flags.socket ?? "/run/rome-signer/signer.sock";
const { team, user } = flags;
const text = flags.text ?? `gateway probe ${new Date().toISOString()}`;
const shared = process.env.GATEWAY_SHARED_SECRET ?? "";
if (!team || !user || !shared) {
  console.log(JSON.stringify({ error: "usage: --team T --user U, GATEWAY_SHARED_SECRET set" }));
  process.exit(2);
}

const checks = {};
const out = { gateway, team, user, checks };
const finish = () => {
  out.ok = Object.values(checks).every((c) => c.ok);
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
};
const stop = (name, result) => {
  checks[name] = { ok: false, ...result };
  finish();
};

/** A fresh instance JWT from the signer, as Rome gets one. */
function instanceToken() {
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

async function call(url, init = {}) {
  try {
    const r = await fetch(url, { redirect: "manual", ...init });
    const raw = await r.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw.slice(0, 300);
    }
    return { status: r.status, body, headers: r.headers };
  } catch (error) {
    return { status: 0, body: String(error.cause?.message ?? error.message) };
  }
}
const json = (method, body, headers = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const asInstance = async (method, body, headers = {}) =>
  json(method, body, { authorization: `Bearer ${await instanceToken()}`, ...headers });

// pinned
if (flags.resolution !== undefined) {
  let pinned;
  try {
    pinned = JSON.parse(flags.resolution);
  } catch {
    pinned = { ok: false, error: "--resolution is not JSON" };
  }
  checks.pinned = { ...pinned, ok: pinned?.ok === true };
  if (!checks.pinned.ok) finish();
}

// health
const health = await call(`${gateway}/health`);
checks.health = {
  ok: health.status === 200 && health.body?.ok === true && health.body?.service === "slack-gateway",
  status: health.status,
  body: health.body,
};
if (!checks.health.ok) finish();

// refused: twice. The first token's key is new to the Worker, so Rome Cloud
// checks it; the second is checked against the Worker's cache, whose audience
// rule is the Worker's own.
const seq = (await call(`${slack}/_control/calls?since=0`)).body?.seq ?? 0;
const refusals = [];
for (let i = 0; i < 2; i++) {
  refusals.push(
    await call(
      `${gateway}/v1/slack/auth.test`,
      await asInstance("POST", {}, { "x-slack-team": team }),
    ),
  );
}
const atSlack = (await call(`${slack}/_control/calls?method=auth.test&since=${seq}`)).body;
checks.refused = {
  ok:
    refusals.every((r) => r.status === 403 && r.body?.error === "method_not_allowed") &&
    Array.isArray(atSlack?.calls) &&
    atSlack.calls.length === 0,
  statuses: refusals.map((r) => r.status),
  body: refusals[1].body,
  calls_at_slack: atSlack?.calls?.length ?? null,
};

// connect, with the instance's own mailbox
const who = await call(`${cloud}/api/instance/whoami`, {
  headers: { authorization: `Bearer ${await instanceToken()}` },
});
const instanceId = who.body?.instanceId;
const accountId = who.body?.account?.id;
if (!instanceId || !accountId)
  stop("connect", { step: "whoami", status: who.status, body: who.body });
const mailbox = await call(`${cloud}/api/relay/mailboxes`, await asInstance("POST", {}));
if (!mailbox.body?.depositUrl)
  stop("connect", { step: "mailbox", status: mailbox.status, body: mailbox.body });
const connect = await call(
  `${gateway}/v1/connect`,
  await asInstance("POST", { depositUrl: mailbox.body.depositUrl }),
);
const depositKey = connect.body?.depositKey;
checks.connect = {
  ok: connect.status === 200 && typeof depositKey === "string",
  status: connect.status,
  instance_id: instanceId,
  deposit_url: mailbox.body.depositUrl.replace(/\.[^.]+$/, ".…"),
  workspaces: connect.body?.workspaces ?? null,
  ...(connect.status === 200 ? {} : { body: connect.body }),
};
if (!checks.connect.ok) finish();

// bind: the approve screen as the member, then Rome Cloud's call to the Worker
await call(`${slack}/_control/sign-in`, json("POST", { team, user }));
const state = await call(`${slack}/_control/state`);
const form = new URLSearchParams({
  client_id: state.body?.client_id ?? state.body?.app?.client_id ?? "",
  scope:
    "app_mentions:read,channels:history,channels:read,chat:write,groups:history,groups:read,im:history,im:read,im:write,users:read",
  redirect_uri: `${cloud}/api/slack/callback`,
  state: "gateway-probe",
  team,
  user,
  decision: "allow",
});
const approved = await call(`${slack}/oauth/v2/authorize/approve`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form.toString(),
});
const code = approved.headers?.get?.("location")
  ? new URL(approved.headers.get("location")).searchParams.get("code")
  : null;
if (!code) stop("bind", { step: "approve", status: approved.status, body: approved.body });
const bind = await call(
  `${gateway}/internal/bind`,
  json("POST", { code, accountId, instanceId }, { authorization: `Bearer ${shared}` }),
);
checks.bind = {
  ok: bind.status === 200 && bind.body?.teamId === team,
  status: bind.status,
  body: bind.body,
};
if (!checks.bind.ok) finish();

// event: the fake Slack signs it and posts it to its events address
const config = await call(`${slack}/_control/config`, json("POST", {}));
const dm = await call(`${slack}/_control/dm`, json("POST", { team, user, text }));
checks.event = {
  ok: dm.body?.event_sent === true && dm.body?.delivery?.status === 200,
  events_url: config.body?.events_url ?? null,
  event_id: dm.body?.event_id ?? null,
  delivery: dm.body?.delivery ?? dm.body,
};
if (!checks.event.ok) finish();

// mailbox: drain the instance's mailbox for that event
const connectUrl =
  mailbox.body.connectUrl ??
  mailbox.body.depositUrl
    .replace(/^http/, "ws")
    .replace("/h/", "/c/")
    .replace(/\.[^.]+$/, "");
const frames = await drain(connectUrl, mailbox.body.drainKey, dm.body.event_id);
const found = frames.find((f) => f.eventId === dm.body.event_id);
checks.mailbox = found
  ? {
      ok: found.slackHeader === "1" && found.signed,
      x_rome_slack: found.slackHeader,
      signature_verified: found.signed,
      seq: found.seq,
    }
  : {
      ok: false,
      frames_seen: frames.length,
      note: "not in the mailbox: a running instance may have taken it first (ctl.sh stop the instance and probe again)",
    };

// cached: an allowed call, twice, on the key the Worker has cached by now
const before = (await call(`${slack}/_control/calls?since=0`)).body?.seq ?? 0;
const infos = [];
for (let i = 0; i < 2; i++) {
  infos.push(
    await call(
      `${gateway}/v1/slack/users.info`,
      await asInstance("POST", { user }, { "x-slack-team": team }),
    ),
  );
}
const infoCalls = (await call(`${slack}/_control/calls?method=users.info&since=${before}`)).body;
checks.cached = {
  ok:
    infos.every((r) => r.status === 200 && r.body?.ok === true && r.body?.user?.id === user) &&
    infoCalls?.calls?.length === 2,
  statuses: infos.map((r) => r.status),
  slack_ok: infos.map((r) => r.body?.ok ?? r.body?.error ?? null),
  calls_at_slack: infoCalls?.calls?.length ?? null,
};
finish();

/** Reads the mailbox for up to 10 s, acknowledging each frame, and returns
 *  what each one carried. */
function drain(url, drainKey, eventId) {
  return new Promise((resolve) => {
    const seen = [];
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${drainKey}` } });
    const done = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(seen);
    };
    const timer = setTimeout(done, 10_000);
    ws.addEventListener("error", done);
    ws.addEventListener("message", (m) => {
      const frame = JSON.parse(String(m.data));
      if (frame.type !== "event") return;
      const headers = Object.fromEntries(
        Object.entries(frame.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const body = frame.body ? Buffer.from(frame.body, "base64") : Buffer.alloc(0);
      const expected = createHmac("sha256", depositKey).update(body).digest("hex");
      const given = String(headers["x-rome-slack-signature"] ?? "");
      let parsed = null;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {}
      seen.push({
        seq: frame.seq,
        eventId: parsed?.event_id ?? null,
        slackHeader: headers["x-rome-slack"] ?? null,
        signed:
          given.length === expected.length &&
          timingSafeEqual(Buffer.from(given), Buffer.from(expected)),
      });
      ws.send(JSON.stringify({ type: "ack", seq: frame.seq }));
      if (parsed?.event_id === eventId) done();
    });
  });
}
