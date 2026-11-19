// Stand-in for one Rome instance: the dashboard routes the verifier calls
// (Connect through setups, connected accounts, a session's recorded messages,
// observed accounts) and a loop
// that drains its relay mailbox and has "the Concierge" repeat each seeded
// code. Runs as its own process so it can be stopped and started; its state
// lives in STATE_FILE across restarts. Breaks: README.md, "Stand-in".
//
// Env: NAME, PORT, CLOUD, SLACK, SECRET, STATE_FILE, BREAK (comma list).

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { frameSignature } from "./cloud.mjs";
import { readBody, send, serve } from "./serve.mjs";

const { NAME, PORT, CLOUD, SLACK, SECRET, STATE_FILE } = process.env;
const breaks = new Set((process.env.BREAK ?? "").split(",").filter(Boolean));
const rand = () => randomBytes(8).toString("hex");

const db = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { connections: [], accounts: [], messages: [], seen: [] };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(db));
const setups = new Map();
const cloudAuth = { authorization: `Bearer ${SECRET}` };

const server = await serve(async (req, res, url) => {
  const p = url.pathname;
  // Like Rome, refuse a mutation that does not show it comes from this origin.
  const sameOrigin =
    req.headers["sec-fetch-site"] === "same-origin" ||
    req.headers.origin === `http://127.0.0.1:${PORT}`;
  if (req.method === "POST" && !sameOrigin)
    return send(res, 403, { error: "Cross-site requests are not allowed." });
  const setupStart = p.match(/^\/api\/connections\/slack_app\/grants\/bot\/setup$/);
  if (setupStart && req.method === "POST") {
    // Like Rome at 49a5cff: one Slack workspace per instance, so no `another`.
    const asked = JSON.parse((await readBody(req)) || "{}");
    if (asked.another)
      return send(res, 400, { error: '"slack_app" does not offer another account.' });
    const cid = rand();
    const state = rand();
    const setup = { cid, oauthState: state, state: null };
    if (breaks.has("R1-fields")) {
      setup.state = {
        status: "awaiting-input",
        form: {
          fields: [
            { name: "botToken", label: "Bot token", secret: true },
            { name: "signingSecret", label: "Signing secret", secret: true },
          ],
        },
      };
    } else {
      const to = new URL("/slack/connect", CLOUD);
      to.searchParams.set("instance", NAME);
      to.searchParams.set("state", state);
      to.searchParams.set("return", `http://127.0.0.1:${PORT}/callback`);
      setup.state = { status: "awaiting-redirect", url: to.toString() };
    }
    setups.set(cid, setup);
    return send(res, 200, { cid, state: setup.state, reattached: false });
  }
  const poll = p.match(/^\/api\/setups\/(\w+)$/);
  if (poll && req.method === "GET") {
    const s = setups.get(poll[1]);
    return s ? send(res, 200, { state: s.state }) : send(res, 404, { error: "Unknown setup." });
  }
  if (p === "/api/setups/return" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    const setup = [...setups.values()].find((s) => s.oauthState === body.state);
    if (!setup) return send(res, 404, { matched: false });
    if (body.error) {
      setup.state = { status: "failed", reason: body.message ?? body.error };
      return send(res, 200, { matched: true, state: setup.state });
    }
    // Broken R1-twice: the first sign-in only leads to a second one.
    if (breaks.has("R1-twice") && !setup.again) {
      setup.again = true;
      setup.oauthState = rand();
      const to = new URL(setup.state.url);
      to.searchParams.set("state", setup.oauthState);
      setup.state = { status: "awaiting-redirect", url: to.toString() };
      return send(res, 200, { matched: true, state: setup.state });
    }
    const got = await fetch(`${CLOUD}/slack/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cloudAuth },
      body: JSON.stringify({ instance: NAME, handoff: body.handoff }),
    });
    if (!got.ok) {
      const why = await got.json().catch(() => ({}));
      setup.state = { status: "failed", reason: why.message ?? `redeem: ${got.status}` };
      return send(res, 200, { matched: true, state: setup.state });
    }
    const grant = await got.json();
    const connectionId = `conn_${rand()}`;
    db.connections.push({
      id: connectionId,
      channel: randomUUID(),
      team: grant.team,
      botToken: grant.botToken,
    });
    db.accounts.push({
      account: { platform: "slack", id: `${grant.team}:${grant.botUserId}` },
      name: `Rome in ${grant.team}`,
      agent: breaks.has("R1-agent") ? null : "core:concierge",
      connection: connectionId,
    });
    save();
    setup.state = { status: "done", grant: { connectionId } };
    return send(res, 200, { matched: true, state: setup.state });
  }
  if (p === "/api/connected-accounts") return send(res, 200, { accounts: db.accounts });
  // Like Rome, a Slack direct message with the bot is one session, and its
  // inbound messages are recorded with role "user" once they start a turn.
  // Its session is named after the connection's channel, which the
  // connection's view gives. Broken R7-name names it after the connection
  // kind instead, so the name the view leads to finds nothing.
  const view = p.match(/^\/api\/connections\/([^/]+)$/);
  if (view && req.method === "GET") {
    const conn = db.connections.find((c) => c.id === decodeURIComponent(view[1]));
    if (!conn) return send(res, 404, { error: "Unknown connection." });
    return send(res, 200, { connection: { id: conn.id, channel: conn.channel } });
  }
  const session = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (session && req.method === "GET") {
    const [, channel, dm] = decodeURIComponent(session[1]).match(/^channel:([^:]+):(\w+)$/) ?? [];
    const named = (m) =>
      breaks.has("R7-name")
        ? channel === "slack_app"
        : db.connections.some((c) => c.team === m.team && c.channel === channel);
    const held = db.messages.filter((m) => m.channel === dm && named(m));
    if (!held.length) return send(res, 404, { error: "Unknown session." });
    return send(
      res,
      200,
      held.map((m) => ({
        id: m.eventId,
        role: "user",
        content: JSON.stringify([{ type: "text", content: m.text }]),
      })),
    );
  }
  // Like Rome's directory, accounts are filed under the platform, and the
  // channel filter matches it exactly.
  if (p === "/api/accounts") {
    const ids = [...new Set(db.messages.map((m) => `${m.team}/${m.user}`))];
    const wanted = url.searchParams.get("channel");
    const accounts = ids
      .map((channelUserId) => ({ channel: "slack", channelUserId }))
      .filter((a) => !wanted || a.channel === wanted);
    return send(res, 200, { accounts, nextCursor: null });
  }
  return send(res, 404, { error: "not found" });
}, Number(PORT));

async function post(token, channel, text) {
  await fetch(`${SLACK}/api/chat.postMessage`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text }),
  });
}

async function otherDirectMessage(team, channel) {
  const state = await (await fetch(`${SLACK}/_control/state`)).json();
  return state.workspaces.find((w) => w.id === team)?.members.find((m) => m.im_channel !== channel)
    ?.im_channel;
}

// "The Concierge": answers each message once, in words of its own.
// Broken R4-pairs holds each odd R4 message until the next one comes.
let held = null;

async function answer(event, team, { now = false } = {}) {
  const conn = db.connections.find((c) => c.team === team) ?? db.connections[0];
  if (!conn) return;
  if (breaks.has("R4-pairs") && !now && /R4-/.test(event.text)) {
    if (!held) {
      held = event;
      return;
    }
    await answer(held, team, { now: true });
    held = null;
  }
  // Broken silent never answers. Variant refuse declines what it was asked,
  // once, as the plain-text Concierge does on a connected account.
  if (breaks.has("silent")) return;
  const asked = breaks.has("refuse")
    ? "I can't repeat codes or other secrets here."
    : "Sure, happy to help with that.";
  // Broken R7-elsewhere answers R7's forged events in another member's direct message.
  if (breaks.has("R7-elsewhere") && /R7F-/.test(event.text)) {
    const other = await otherDirectMessage(team, event.channel);
    if (other) await post(conn.botToken, other, asked);
    return;
  }
  const times = breaks.has("R4") ? 2 : 1;
  for (let i = 0; i < times; i++) await post(conn.botToken, event.channel, asked);
  // Broken R4-elsewhere: each reply is also posted in another member's direct message.
  if (breaks.has("R4-elsewhere")) {
    const other = await otherDirectMessage(team, event.channel);
    if (other) await post(conn.botToken, other, asked);
  }
}

async function drainOnce() {
  const res = await fetch(`${CLOUD}/relay/${NAME}/drain`, { headers: cloudAuth });
  const { frames } = await res.json();
  const done = [];
  for (const f of frames) {
    done.push(f.id);
    if (f.sig !== frameSignature(SECRET, f.body)) continue;
    const payload = JSON.parse(f.body);
    if (db.seen.includes(payload.event_id)) continue;
    db.seen.push(payload.event_id);
    const ev = payload.event;
    if (ev?.type !== "message" || ev.channel_type !== "im") continue;
    // Broken R7-blind: an event for a workspace this instance does not hold
    // gets a generic answer in this instance's own workspace, unrecorded.
    if (breaks.has("R7-blind") && !db.connections.some((c) => c.team === payload.team_id)) {
      const own = db.connections[0];
      const state = await (await fetch(`${SLACK}/_control/state`)).json();
      const dm = state.workspaces.find((w) => w.id === own?.team)?.members[0]?.im_channel;
      if (dm) await post(own.botToken, dm, "Sure, done.");
      continue;
    }
    // Broken R7-lookup: an event for a workspace this instance does not hold
    // is looked up in Slack, then dropped with nothing recorded.
    if (breaks.has("R7-lookup") && !db.connections.some((c) => c.team === payload.team_id)) {
      await fetch(`${SLACK}/api/users.info`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${db.connections[0]?.botToken}`,
        },
        body: JSON.stringify({ user: ev.user }),
      });
      continue;
    }
    // Broken R7-elsewhere also leaves forged events unrecorded.
    const unrecorded = breaks.has("R7-elsewhere") && /R7F-/.test(ev.text ?? "");
    if (!unrecorded)
      db.messages.push({
        eventId: payload.event_id,
        team: payload.team_id,
        user: ev.user,
        channel: ev.channel,
        text: ev.text,
      });
    save();
    await answer(ev, payload.team_id);
  }
  if (done.length) {
    await fetch(`${CLOUD}/relay/${NAME}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cloudAuth },
      body: JSON.stringify({ ids: done }),
    });
  }
}

// Broken R6: whatever waited in the mailbox while stopped is thrown away.
// Broken R6-drop5: the first 5 of them are, as a full worker pool would.
if (breaks.has("R6") || breaks.has("R6-drop5")) {
  const { frames } = await (
    await fetch(`${CLOUD}/relay/${NAME}/drain`, { headers: cloudAuth })
  ).json();
  const dropped = breaks.has("R6") ? frames : frames.slice(0, 5);
  await fetch(`${CLOUD}/relay/${NAME}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cloudAuth },
    body: JSON.stringify({ ids: dropped.map((f) => f.id) }),
  });
}

process.on("SIGTERM", () => {
  server.close().then(() => process.exit(0));
});
for (;;) {
  await drainOnce().catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
}
