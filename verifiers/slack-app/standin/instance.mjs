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
const TASK_DELAY_MS = 4000;

const db = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { connections: [], accounts: [], messages: [], seen: [] };
// Logs every change in the connections it holds, and what it starts with,
// so a proof run can tell a lost connection from a slow one.
const log = (msg) => process.stderr.write(`[instance ${NAME} ${new Date().toISOString().slice(11, 23)} pid ${process.pid}] ${msg}\n`);
const heldList = () => db.connections.map((c) => `${c.id}/${c.team}`).join(",") || "none";
let lastHeld = null;
const save = () => {
  writeFileSync(STATE_FILE, JSON.stringify(db));
  if (heldList() !== lastHeld) log(`connections now ${(lastHeld = heldList())}`);
};
log(`start: state file ${existsSync(STATE_FILE) ? "read" : "missing"}, connections ${(lastHeld = heldList())}`);
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
    // A repair of the same workspace replaces its connection and keeps its
    // channel and connected account, as Rome does. Broken R8-new-account
    // gives the repair a new connected account.
    const prior = db.connections.find((c) => c.team === grant.team);
    db.connections = db.connections.filter((c) => c.team !== grant.team);
    db.connections.push({
      id: connectionId,
      channel: prior?.channel ?? randomUUID(),
      team: grant.team,
      botToken: grant.botToken,
    });
    const accountId = `${grant.team}:${grant.botUserId}`;
    const kept = db.accounts.find((a) => a.account.id === accountId);
    if (kept && !breaks.has("R8-new-account")) kept.connection = connectionId;
    else {
      if (kept) kept.connection = null;
      db.accounts.push({
        account: {
          platform: "slack",
          id: kept ? `${accountId}:${rand()}` : accountId,
        },
        name: `Rome in ${grant.team}`,
        agent: breaks.has("R1-agent") ? null : "core:concierge",
        connection: connectionId,
      });
    }
    save();
    setup.state = { status: "done", grant: { connectionId } };
    return send(res, 200, { matched: true, state: setup.state });
  }
  if (p === "/api/connected-accounts") return send(res, 200, { accounts: db.accounts });
  // R12: each connection's switch for answering other full members, off on
  // a fresh connect. Broken R12-default-on starts on; R12-switch-sticks
  // cannot be turned off; R12-instance-wide also turns the instance-wide
  // replyToBondLevels to members.
  const switchView = p.match(/^\/api\/connections\/([^/]+)\/answer-members$/);
  if (switchView && req.method === "PUT") {
    if (!sameOrigin) return send(res, 403, { error: "Cross-site requests are not allowed." });
    const conn = db.connections.find((c) => c.id === decodeURIComponent(switchView[1]));
    if (!conn) return send(res, 404, { error: "Unknown connection." });
    const { on } = JSON.parse((await readBody(req)) || "{}");
    if (typeof on !== "boolean") return send(res, 400, { error: "on must be a boolean." });
    conn.answerMembers = breaks.has("R12-switch-sticks") ? answersMembers(conn) || on : on;
    if (breaks.has("R12-instance-wide") && on) db.replyTo = ["guardian", "other"];
    save();
    return send(res, 200, { answerMembers: answersMembers(conn) });
  }
  // The dashboard's searches: memory files, and its own chats (none here).
  if (p === "/api/memory/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    if (!q) return send(res, 400, { error: "q parameter is required" });
    const hits = (db.memory ?? [])
      .map((content, i) => ({ content, file: "memory/notes.md", line: i + 1 }))
      .filter((h) => h.content.toLowerCase().includes(q));
    return send(res, 200, hits);
  }
  if (p === "/api/chat/sessions/search" && req.method === "GET") return send(res, 200, []);
  if (p === "/api/settings" && req.method === "GET")
    return send(res, 200, { replyToBondLevels: db.replyTo ?? ["guardian"] });
  if (p === "/api/settings" && req.method === "PUT") {
    if (!sameOrigin) return send(res, 403, { error: "Cross-site requests are not allowed." });
    const body = JSON.parse((await readBody(req)) || "{}");
    if (Array.isArray(body.replyToBondLevels)) db.replyTo = body.replyToBondLevels;
    save();
    return send(res, 200, { replyToBondLevels: db.replyTo ?? ["guardian"] });
  }
  if (p === "/api/action-executions" && req.method === "GET") return send(res, 200, db.executions ?? []);
  // R10: the Connect picker, one Slack entry among placeholders (id null).
  // Broken R10-two-entries also offers slack_bot.
  if (p === "/api/connections" && req.method === "GET") {
    // The official kind shows once: connected, else as its placeholder.
    const placeholders = [
      ...(db.connections.length ? [] : [{ id: null, connectionKind: "slack_app", label: "slack_app" }]),
      { id: null, connectionKind: "discord", label: "Discord" },
      ...(breaks.has("R10-two-entries") ? [{ id: null, connectionKind: "slack_bot", label: "Slack bot" }] : []),
    ];
    const held = [
      ...db.connections.map((c) => ({ id: c.id, connectionKind: "slack_app", label: "slack_app", state: "working" })),
      ...(db.old ?? []).map((c) => ({ id: c.id, connectionKind: c.kind, label: c.kind, state: "working" })),
    ];
    return send(res, 200, { connections: [...held, ...placeholders] });
  }
  if (p === "/settings/connections") {
    // Held connections, then the kinds offered under "Add a connection", each
    // name on its own line. The list renders after a fetch, as the dashboard's does.
    const held = [
      ...db.connections.map(() => "Slack"),
      ...(db.old ?? []).map((c) => (c.kind === "slack_bot" ? "Slack bot (Socket Mode)" : "Slack (OAuth)")),
    ];
    const offered = [
      "Slack",
      "Discord",
      ...(breaks.has("R10-two-entries") ? ["Slack bot"] : []),
      ...(breaks.has("R10-page-twice") ? ["Slack"] : []),
    ];
    const li = (xs) => xs.map((e) => `<li><div>${e}</div><button>Open</button></li>`).join("");
    // Each Slack app connection's switch for answering other members. Broken
    // R12-page-no-switch has none.
    const switches = breaks.has("R12-page-no-switch")
      ? ""
      : db.connections
          .map(
            (c) =>
              `<label><input type="checkbox" role="switch" ${answersMembers(c) ? "checked" : ""} onchange="fetch('/api/connections/${c.id}/answer-members',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({on:this.checked})})"> Answer other members of this workspace</label>`,
          )
          .join("");
    const body = `<h2>Your connections</h2><ul>${li(held)}</ul>${switches}<h2>Add a connection</h2><ul>${li(offered)}</ul>`;
    return send(
      res,
      200,
      `<!doctype html><html><body><h1>Connections</h1><div id="list">Loading…</div><script>setTimeout(() => { document.getElementById("list").innerHTML = ${JSON.stringify(body)}; }, 1500);</script></body></html>`,
      "text/html",
    );
  }
  // The dashboard's chat with the Concierge, where its actions run. Like the
  // product, it answers "On it" at once and posts the task's result later.
  if (p === "/api/chat/sessions/concierge/turns" && req.method === "POST") {
    const { text } = JSON.parse(await readBody(req));
    db.webchat = [
      ...(db.webchat ?? []),
      { id: rand(), role: "user", content: text },
      { id: rand(), role: "assistant", content: "On it." },
    ];
    save();
    setTimeout(async () => {
      const conn = db.connections[0] ?? (db.tokenFile ? { team: db.tokenFile.teamId } : null);
      const reply = (conn && (await act(conn, text ?? "", null))) ?? "Sure, happy to help with that.";
      db.webchat = [...db.webchat, { id: rand(), role: "assistant", content: reply }];
      save();
    }, TASK_DELAY_MS);
    return send(res, 200, { turnId: rand(), disposition: "started", sessionId: "concierge" });
  }
  if (p === "/api/chat/sessions/concierge/messages") return send(res, 200, db.webchat ?? []);
  // The old kinds cannot be newly connected. Broken R10-bot-connects lets a
  // slack_bot setup start; R10-oauth-connects sends the OAuth start on to
  // Slack; R10-reconnect allows both once one was disconnected.
  const reopened = breaks.has("R10-reconnect") && db.oldDisconnected;
  if (p === "/api/connections/slack_bot/grants/bot/setup" && req.method === "POST") {
    if (breaks.has("R10-bot-connects") || reopened)
      return send(res, 200, { cid: rand(), state: { status: "awaiting-input", form: { fields: [{ name: "botToken" }] } }, reattached: false });
    return send(res, 410, { error: "Slack bot connections are retired; use Slack." });
  }
  if (p === "/api/oauth/slack/start") {
    if (breaks.has("R10-oauth-connects") || reopened) {
      res.writeHead(302, { location: `${SLACK}/oauth/v2/authorize?client_id=old` });
      return res.end();
    }
    return send(res, 410, { error: "This Slack connection is retired; use Slack." });
  }
  const oldView = p.match(/^\/api\/connections\/([^/]+)$/);
  if (oldView && req.method === "DELETE" && (db.old ?? []).some((c) => c.id === decodeURIComponent(oldView[1]))) {
    const gone = db.old.find((c) => c.id === decodeURIComponent(oldView[1]));
    db.old = db.old.filter((c) => c !== gone);
    if (gone.kind === "slack") delete db.tokenFile;
    db.oldDisconnected = true;
    save();
    stopSocket(gone.id);
    return send(res, 200, { ok: true, connection: null });
  }
  // Like Rome, a Slack direct message with the bot is one session, and its
  // inbound messages are recorded with role "user" once they start a turn.
  // Its session is named after the connection's channel, which the
  // connection's view gives. Broken R7-name names it after the connection
  // kind instead, so the name the view leads to finds nothing.
  const view = p.match(/^\/api\/connections\/([^/]+)$/);
  if (view && req.method === "GET") {
    const conn = db.connections.find((c) => c.id === decodeURIComponent(view[1]));
    if (!conn) return send(res, 404, { error: "Unknown connection." });
    return send(res, 200, {
      connection: {
        id: conn.id,
        channel: conn.channel,
        state: conn.broken ? "broken" : "working",
        answerMembers: answersMembers(conn),
        // Broken R13-tell shows that it had to read Slack for a chat.
        ...(breaks.has("R13-tell") && conn.readSlack ? { copyMissing: true } : {}),
      },
    });
  }
  // Disconnect: Rome gives the token up with Slack. Broken R8-keep-token does not.
  if (view && req.method === "DELETE") {
    const conn = db.connections.find((c) => c.id === decodeURIComponent(view[1]));
    if (!conn) return send(res, 404, { error: "Unknown connection." });
    if (!breaks.has("R8-keep-token"))
      await fetch(`${SLACK}/api/auth.revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${conn.botToken}` },
      });
    db.connections = db.connections.filter((c) => c !== conn);
    for (const a of db.accounts) if (a.connection === conn.id) a.connection = null;
    save();
    return send(res, 200, { ok: true, connection: null });
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

async function post(token, channel, text, threadTs) {
  await fetch(`${SLACK}/api/chat.postMessage`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
}

/** A Slack Web API call with the bot token, as JSON. */
async function api(token, method, params = {}) {
  const res = await fetch(`${SLACK}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
  const out = await res.json();
  if (res.status === 429) out.retryAfter = Number(res.headers.get("retry-after")) || 60;
  return out;
}

/** The groups the bot can see, by name, with whether it is in each. */
async function groups(conn) {
  const r = await api(conn.botToken, "conversations.list", { types: "public_channel" });
  return r.ok ? r.channels : [];
}

/**
 * R9: the agent acting in Slack through the connection, as send, read and
 * search, and nothing else. Answers `text` when it asks for one of those,
 * else returns null. A group or direct message is named by its id in the
 * text, else by #name through the listing. Search covers what this instance
 * kept (direct messages and mentions), and refills a named chat from Slack.
 * Broken R9-lazy never acts; R9-blind reads but says nothing it read;
 * R9-react adds the reaction; R9-join also searches groups it is not in.
 * Variant dm-only, as the app is built, may not read or list groups.
 */
async function act(conn, text, dmChannel) {
  const react = /\breact|reaction\b/i.test(text);
  const quoted = text.match(/\bsend "(.+?)" to #(\w+)/i);
  const send = quoted
    ? [quoted[0], quoted[2], quoted[1]]
    : text.match(/(?:post|send a message to)\b.*?(?:#|the )(\w+)\b.*?:\s*"?(.+?)"?$/i);
  const list = /which .*channels|list the slack groups|channels can you see/i.test(text);
  const search = /search|find|look up/i.test(text);
  const read = /read|messages|history|look back|said/i.test(text);
  if (!react && !send && !list && !search && !read) return null;
  if (breaks.has("R9-lazy")) return "Sure, I'll look into that.";
  const id = text.match(/\b([CDG][A-Z0-9]{8,})\b/)?.[1];
  // Broken R14-by-name cannot find a group by its name.
  const byName = async (n) => {
    const found = (await groups(conn)).find((c) => c.name === n)?.id;
    return breaks.has("R14-by-name") ? undefined : found;
  };
  // Slack's refusals in the product's words; broken R14-raw-refusal passes
  // Slack's error on as it is.
  const refusal = (error, channel) => {
    if (breaks.has("R14-raw-refusal")) return `I could not read it: ${error}.`;
    if (error === "missing_scope")
      return "Rome's Slack app may not read channels in this workspace yet: it was connected before the app asked for that. Ask the guardian to approve the app again from Slack in Settings > Connections.";
    if (error === "not_in_channel" || error === "channel_not_found")
      return `Rome's Slack app is not a member of chat ${channel}, so it may not read it (not_in_channel). Someone in Slack can add it with /invite.`;
    return `I could not read it: ${error}.`;
  };
  if (react) {
    if (!breaks.has("R9-react")) return "I can only send, read and search messages in Slack.";
    const channel = id ?? (await byName("general"));
    const h = await api(conn.botToken, "conversations.history", { channel, limit: 1 });
    await api(conn.botToken, "reactions.add", { channel, timestamp: h.messages?.[0]?.ts, name: "thumbsup" });
    return "Done.";
  }
  if (send) {
    // Like the product, the official app sends when connected; an old OAuth
    // slack connection's token file serves when it is alone.
    const token = conn.botToken ?? db.tokenFile?.botToken;
    const channel = id ?? (await byName(send[1]));
    if (!channel) return `I can't find #${send[1]}.`;
    const r = await api(token, "chat.postMessage", { channel, text: send[2] });
    // Listed as the product's action listing does, with the route it took.
    db.executions ??= [];
    db.executions.unshift({
      rootExecution: { actionName: "slack.send", status: r.ok ? "succeeded" : "failed", startedAt: new Date().toISOString(), args: { channel, via: conn.botToken ? "slack_app" : "slack" } },
      children: [],
    });
    save();
    return r.ok ? `Posted it in #${send[1]}.` : `I could not post it: ${r.error}.`;
  }
  if (list) {
    const r = await api(conn.botToken, "conversations.list", { types: "public_channel" });
    if (!r.ok) return refusal(r.error);
    // Broken R14-lists-all names groups the app is not in too.
    const shown = breaks.has("R14-lists-all") ? r.channels : r.channels.filter((c) => c.is_member);
    return `I am in: ${shown.map((c) => `#${c.name}`).join(", ")}.`;
  }
  const history = async (channel) => {
    if (!channel) return { ok: false, error: "no channel" };
    return api(conn.botToken, "conversations.history", { channel, limit: 15 });
  };
  if (search) {
    const word = (
      text.match(/(?:mentions|about(?: the)?|Look up)\s+"?([^"]+?)"?(?:\s+and\b|\s+in\b|\.|$)/i)?.[1] ?? ""
    )
      .replace(/^the\s+/i, "")
      .toLowerCase();
    const found = db.messages.filter((m) => m.text?.toLowerCase().includes(word)).map((m) => m.text);
    // A chat named by id or by #name is read from Slack; broken
    // R14-wipe-forgets reads only what it kept.
    const named = id ?? (text.match(/#(\w+)/) ? await byName(text.match(/#(\w+)/)[1]) : null);
    if (named && breaks.has("R14-wipe-forgets"))
      await history(named).then(() => {});
    else if (named) {
      const h = await history(named);
      if (h.ok) found.push(...h.messages.filter((m) => m.text?.toLowerCase().includes(word)).map((m) => m.text));
    }
    if (breaks.has("R9-join"))
      for (const g of await groups(conn))
        if (!g.is_member) {
          const h = await (await fetch(`${SLACK}/_control/history?team=${conn.team}&channel=${g.id}`)).json();
          if (h.ok) found.push(...h.messages.filter((m) => m.text?.toLowerCase().includes(word)).map((m) => m.text));
        }
    const uniq = [...new Set(found)].filter((t) => !/search|find|look up/i.test(t));
    return uniq.length
      ? `I found: ${uniq.join(" / ")} (I searched what I have kept of our direct messages and mentions${named ? `, and ${named} in Slack` : ""})`
      : `Nothing mentions ${word} in what I have kept.`;
  }
  const channel = id ?? (text.match(/#(\w+)/) ? await byName(text.match(/#(\w+)/)[1]) : dmChannel);
  // Broken R14-quiet-read reads a group the app is not in through Slack's
  // own export.
  if (breaks.has("R14-quiet-read") && channel && !channel.startsWith("D")) {
    const g = (await groups(conn)).find((c) => c.id === channel);
    if (g && !g.is_member) {
      const x = await (await fetch(`${SLACK}/_control/history?team=${conn.team}&channel=${channel}`)).json();
      return `The latest messages: ${(x.messages ?? []).map((m) => m.text).join(" / ")}`;
    }
  }
  const h = await history(channel);
  if (!h.ok) return refusal(h.error, channel);
  if (breaks.has("R9-blind")) return "I read it, there is nothing much there.";
  return `The latest messages: ${h.messages.map((m) => m.text).join(" / ")}`;
}

/** Whether a connection answers other full members (R12's switch). */
const answersMembers = (conn) => conn.answerMembers ?? breaks.has("R12-default-on");

const slackState = async () => (await fetch(`${SLACK}/_control/state`)).json();

const REMEMBER = /Please remember (?:this|these) for later:/i;

/** The value noted for `thing` in `texts`, newest last. */
const noted = (texts, thing) =>
  texts
    .filter((t) => REMEMBER.test(t ?? ""))
    .flatMap((t) => [...t.matchAll(/my ([^;]+?) is (.+?)(?=;|\.\s|\.$|$)/g)])
    .filter((m) => m[1].toLowerCase() === thing.toLowerCase())
    .at(-1)?.[2];

/**
 * What the guardian noted for `thing` in direct message `channel`: from this
 * instance's copy, else by reading the chat's history in Slack. Broken
 * R13-forget never reads Slack.
 */
async function recall(conn, channel, thing) {
  // Variant R12-decline2 would not keep 2 of R12's 8 facts; R12-decline4, 4.
  if (breaks.has("R12-decline2") && /restaurant|dog/i.test(thing)) return undefined;
  if (breaks.has("R12-decline4") && /restaurant|dog|niece|best friend/i.test(thing))
    return undefined;
  // Variant R13-memory answers from its memory alone.
  if (breaks.has("R13-memory")) return noted(db.memory ?? [], thing);
  const fromCopy = noted(
    db.messages.filter((m) => m.channel === channel).map((m) => m.text),
    thing,
  );
  if (fromCopy || breaks.has("R13-forget") || breaks.has("R13-short-memory")) return fromCopy;
  // Pages through Slack's history under its limit, waiting out a 429, and
  // keeps what it read as its copy again.
  const read = [];
  let cursor = "";
  for (let i = 0; i < 100; i++) {
    const q = new URLSearchParams({ channel, limit: "15", ...(cursor ? { cursor } : {}) });
    const res = await fetch(`${SLACK}/api/conversations.history?${q}`, {
      headers: { authorization: `Bearer ${conn.botToken}` },
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 1) * 1000));
      continue;
    }
    const page = await res.json();
    if (!page.ok) break;
    read.push(...page.messages);
    cursor = page.response_metadata?.next_cursor ?? "";
    // Enough once the fact is in what was read, as Slack's limit asks.
    if (noted(read.map((m) => m.text), thing)) break;
    if (!page.has_more || !cursor) break;
  }
  conn.readSlack = true;
  for (const m of read)
    if (!m.bot_id && m.user)
      db.messages.push({ team: conn.team, user: m.user, channel, text: m.text, ts: m.ts });
  save();
  return noted(
    read
      .slice()
      .sort((x, y) => Number(x.ts) - Number(y.ts))
      .map((m) => m.text),
    thing,
  );
}

/**
 * The stand-in Concierge's words for `event`: it notes what the guardian asks
 * it to remember and gives it back to the guardian alone. A visitor's
 * question about the guardian gets a refusal; broken R12-leak answers it.
 */
async function words(conn, event, team) {
  const text = event.text ?? "";
  if (REMEMBER.test(text)) {
    // It saves what it was told to its memory, as the Concierge does.
    db.memory = [...(db.memory ?? []), text];
    save();
    return "Noted, I'll remember that.";
  }
  const guardian = (await slackState()).workspaces.find((w) => w.id === team)?.installed_by;
  if (event.user === guardian) {
    const acted = await act(conn, text, event.channel);
    if (acted) return acted;
  }
  const mine = text.match(/What (?:is|are) my (.+?)\?/i);
  if (mine && event.user === guardian) {
    const things = mine[1].split(/, | and /);
    const said = [];
    for (const thing of things) {
      const v = await recall(conn, event.channel, thing);
      said.push(v ? `Your ${thing} is ${v}.` : `I don't have your ${thing} noted.`);
    }
    return said.join(" ");
  }
  const about = text.match(/(?:What is|remind me of) .+?'s (.+?)(?:,|\?)/i);
  if (about && event.user !== guardian) {
    if (!breaks.has("R12-leak")) return "I can't share another person's details.";
    const theirs = db.messages.filter((m) => m.team === team && m.user === guardian);
    return `It is ${noted(
      theirs.map((m) => m.text),
      about[1],
    )}.`;
  }
  return "Sure, happy to help with that.";
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
  // A member who is not the guardian gets a reply only once "other" is on.
  const guardian = (await slackState()).workspaces.find((w) => w.id === team)?.installed_by;
  // A member who is not the guardian is answered only with the connection's
  // switch on, and only as a full member: a guest, a bot, a deleted user or
  // a failed lookup is not answered. Broken R12-ignore-setting never answers
  // members; R12-guests answers guests too.
  if (event.user !== guardian) {
    if (!answersMembers(conn) || breaks.has("R12-ignore-setting")) return;
    const who = await api(conn.botToken, "users.info", { user: event.user });
    const u = who.user;
    const full = who.ok && u && !u.is_bot && !u.deleted && !u.is_restricted && !u.is_ultra_restricted;
    if (!full && !(breaks.has("R12-guests") && who.ok && u && !u.is_bot && !u.deleted)) return;
  }
  // Broken silent never answers. Variant refuse declines what it was asked,
  // once, as the plain-text Concierge does on a connected account.
  if (breaks.has("silent")) return;
  const asked = breaks.has("refuse")
    ? "I can't repeat codes or other secrets here."
    : await words(conn, event, team);
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

// A mention is answered once in a thread under it. Broken R5-top answers at
// the top of the group; R5-twice answers twice.
async function answerMention(conn, ev) {
  const thread = breaks.has("R5-top") ? undefined : (ev.thread_ts ?? ev.ts);
  const times = breaks.has("R5-twice") ? 2 : 1;
  const said = (await threadContext(conn, ev)) ?? "Sure, happy to help with that.";
  for (let i = 0; i < times; i++) await post(conn.botToken, ev.channel, said, thread);
}

/**
 * R14: a mention that is a reply inside a thread is answered from the
 * thread's earlier messages, read once per thread (first 15, oldest first).
 * Without the scope it answers without them. Broken R14-no-thread never
 * reads the thread; R14-replies-each reads it on every mention;
 * R14-old-error puts Slack's error in the thread.
 */
async function threadContext(conn, ev) {
  if (!ev.thread_ts || ev.thread_ts === ev.ts || breaks.has("R14-no-thread")) return null;
  // Broken R14-says-unread never reads a thread and says so.
  if (breaks.has("R14-says-unread")) return "I could not read this thread just now.";
  const key = `${conn.team}/${ev.channel}/${ev.thread_ts}`;
  db.threads ??= {};
  const cached = db.threads[key];
  // A thread read once is read again only from its newest message seen, so
  // what was said in between arrives. Broken R14-replies-each reads it whole
  // every time; R14-reread-old reads again from the thread's top.
  const params = { channel: ev.channel, ts: ev.thread_ts, limit: 15 };
  if (cached && !breaks.has("R14-replies-each"))
    params.oldest = breaks.has("R14-reread-old") ? ev.thread_ts : cached.at(-1).ts;
  // Slack paces this method (one a minute per workspace): wait out a 429
  // once, as the product does, for up to 90 s.
  let r = await api(conn.botToken, "conversations.replies", params);
  if (r.error === "ratelimited" && !breaks.has("R14-no-wait")) {
    await new Promise((ok) => setTimeout(ok, Math.min(90, (r.retryAfter ?? 60) + 1) * 1000));
    r = await api(conn.botToken, "conversations.replies", params);
  }
  if (!r.ok && r.error === "ratelimited" && !cached) return "I could not read this thread just now, Slack asked me to slow down.";
  if (!r.ok && !cached) return breaks.has("R14-old-error") ? `I could not read this thread: ${r.error}.` : null;
  if (r.ok) {
    const got = r.messages.slice(0, 15).map((m) => ({ ts: m.ts, text: m.text, bot: Boolean(m.bot_id) }));
    const merged = new Map([...(params.oldest ? cached : []), ...got].map((m) => [m.ts, m]));
    db.threads[key] = [...merged.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
    save();
  }
  const earlier = db.threads[key].filter((m) => !m.bot && Number(m.ts) < Number(ev.ts)).map((m) => m.text);
  return earlier.length ? `From this thread: ${earlier.join(" / ")}` : null;
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
    const conn = db.connections.find((c) => c.team === payload.team_id);
    // Removal: the connection shows broken. Broken R8-never ignores it.
    if (ev?.type === "app_uninstalled" || ev?.type === "tokens_revoked") {
      if (conn && !breaks.has("R8-never")) conn.broken = true;
      save();
      continue;
    }
    if (ev?.type === "app_mention") {
      // Rome keeps the mentions it heard.
      db.messages.push({ team: payload.team_id, user: ev.user, channel: ev.channel, text: ev.text, ts: ev.ts });
      save();
      if (conn && !breaks.has("silent")) await answerMention(conn, ev);
      continue;
    }
    // A plain group message: heard only by broken R14-hears-all.
    if (ev?.type === "message" && ev.channel_type !== "im" && !ev.bot_id && breaks.has("R14-hears-all") && conn) {
      await post(conn.botToken, ev.channel, "I saw that.", ev.ts);
      continue;
    }
    if (ev?.type !== "message" || ev.channel_type !== "im") continue;
    // Slack echoes the bot's own posts back as events; they are not messages to answer.
    if (ev.bot_id) continue;
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

// R10: an old slack_bot hears over Socket Mode and answers with its own
// token. Broken R10-restart-loses drops the old connections on a restart.
const sockets = new Map();
function stopSocket(id) {
  sockets.get(id)?.close();
  sockets.delete(id);
}
async function openSocket(c) {
  const opened = await (
    await fetch(`${SLACK}/api/apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.appToken}` },
    })
  ).json();
  if (!opened.ok) return;
  const u = new URL(opened.url);
  const ws = new WebSocket(`ws://${new URL(SLACK).host}${u.pathname}${u.search}`);
  sockets.set(c.id, ws);
  ws.addEventListener("message", async (m) => {
    const frame = JSON.parse(String(m.data));
    if (!frame.envelope_id) return;
    ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
    const ev = frame.payload?.event;
    if (ev?.type === "message" && ev.channel_type === "im" && !ev.bot_id)
      await post(c.botToken, ev.channel, "Hello back, from the Slack bot.");
  });
}
if (db.old?.length) {
  if (breaks.has("R10-restart-loses") && db.oldStarted) {
    db.old = [];
    delete db.tokenFile;
  }
  db.oldStarted = true;
  save();
  for (const c of db.old.filter((x) => x.kind === "slack_bot")) await openSocket(c).catch(() => {});
}

process.on("SIGTERM", () => {
  log(`SIGTERM, connections ${heldList()}`);
  server.close().then(() => {
    log("exit");
    process.exit(0);
  });
});
for (;;) {
  await drainOnce().catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
}
