// What the fake Slack adds for phase 2: history and thread reads under Slack's
// limit for apps outside the Marketplace, scopes, group messages, threads,
// removal and reinstall, and auth.test of the newest bot token.
// Run: node --test environments/slack-app/fake-slack/
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, start } from "./server.mjs";

const APP_SCOPES = "app_mentions:read,chat:write,im:history,im:read,im:write,users:read";
const A = "TA0000AAAA";
const GUARDIAN = "UA0000GUARD";
const BOB = "UA0000BOB01";
const received = [];
// Set by a test to act on an event before acknowledging it, as an app may.
let onEvent = null;
let receiver;
let fake;
let base;

before(async () => {
  receiver = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(envelope);
    if (onEvent) await onEvent(envelope);
    res.writeHead(200).end("ok");
  }).listen(0);
  await new Promise((r) => receiver.once("listening", r));
  fake = start(
    loadConfig({
      port: 0,
      workspacesFile: fileURLToPath(new URL("../config/workspaces.json", import.meta.url)),
      signingSecret: "s",
      clientSecret: "c",
      clientId: "111.222",
      eventsUrl: `http://127.0.0.1:${receiver.address().port}/events`,
      retryDelaysMs: "",
      historyWindowMs: 400,
    }),
  );
  await new Promise((r) => fake.servers[0].once("listening", r));
  base = `http://127.0.0.1:${fake.servers[0].address().port}`;
});

after(() => {
  receiver.close();
  for (const s of fake.servers) s.close();
});

async function api(method, args, token) {
  const res = await fetch(`${base}/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: new URLSearchParams(args),
  });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), ...(await res.json()) };
}

async function ctl(path, body) {
  const res = await fetch(`${base}/_control${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json()) };
}

async function install(team, user, scopes, userScopes = "") {
  const approve = await fetch(`${base}/oauth/v2/authorize/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "111.222",
      scope: scopes,
      user_scope: userScopes,
      redirect_uri: "http://cloud.test/cb",
      team,
      user,
      decision: "allow",
    }),
  });
  const code = new URL(approve.headers.get("location")).searchParams.get("code");
  return api("oauth.v2.access", { client_id: "111.222", client_secret: "c", code });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("history and thread reads, the limit, scopes, group messages, removal and reinstall", async () => {
  const first = await install(A, GUARDIAN, APP_SCOPES);
  const token = first.access_token;
  const dm = (await ctl("/state")).workspaces[0].members.find((m) => m.id === BOB).im_channel;

  // A member who is not the one who signed in writes to the app.
  for (let i = 1; i <= 20; i++) {
    const sent = await ctl("/dm", { team: A, user: BOB, text: `fact ${i}` });
    assert.equal(sent.ok, true);
  }
  const lastEvent = received.at(-1);
  assert.equal(lastEvent.event.user, BOB);
  assert.equal(lastEvent.event.channel, dm);

  // The bot answers in a thread under the first message.
  const firstTs = (await ctl(`/history?team=${A}&channel=${dm}`)).messages[0].ts;
  const reply = await api(
    "chat.postMessage",
    { channel: dm, text: "noted", thread_ts: firstTs },
    token,
  );
  assert.equal(reply.ok, true);

  // Limited: at most 15 a page, newest first, then 429 with Retry-After.
  const page1 = await api("conversations.history", { channel: dm, limit: 100 }, token);
  assert.equal(page1.ok, true);
  assert.equal(page1.messages.length, 15);
  assert.equal(page1.messages[0].text, "fact 20");
  assert.equal(page1.has_more, true);
  assert.ok(page1.response_metadata.next_cursor);
  const refused = await api(
    "conversations.history",
    { channel: dm, cursor: page1.response_metadata.next_cursor },
    token,
  );
  assert.equal(refused.status, 429);
  assert.equal(refused.error, "ratelimited");
  assert.ok(Number(refused.retryAfter) >= 1);
  await sleep(450);
  const page2 = await api(
    "conversations.history",
    { channel: dm, cursor: page1.response_metadata.next_cursor },
    token,
  );
  assert.equal(page2.messages.length, 5);
  assert.equal(page2.has_more, false);
  const parent = page2.messages.at(-1);
  assert.equal(parent.text, "fact 1");
  assert.equal(parent.reply_count, 1);

  // replies has its own limit, and answers the parent first.
  const thread = await api("conversations.replies", { channel: dm, ts: firstTs }, token);
  assert.deepEqual(
    thread.messages.map((m) => m.text),
    ["fact 1", "noted"],
  );
  assert.equal(thread.messages[1].bot_id, "BBOTA0000AAAA");
  const calls = (await ctl(`/calls?team=${A}&method=conversations.history`)).calls;
  assert.deepEqual(
    calls.map((c) => c.error ?? "ok"),
    ["ok", "ratelimited", "ok"],
  );

  // Without the limit: one page holds all, and nothing is refused.
  await ctl("/config", { history_limit: false });
  const all = await api("conversations.history", { channel: dm }, token);
  const again = await api("conversations.history", { channel: dm, oldest: firstTs }, token);
  assert.equal(all.messages.length, 20);
  assert.equal(again.ok, true);
  assert.equal(again.messages.length, 19);
  await ctl("/config", { history_limit: true });

  // A group: a message that mentions nobody sends no event, a mention does,
  // and the bot's thread reply shows under it. Reading the group needs
  // channels:history, which this install was not granted.
  const before = received.length;
  const plain = await ctl("/group-message", { team: A, user: BOB, text: "lunch?" });
  assert.equal(plain.event_sent, false);
  assert.equal(received.length, before);
  const mention = await ctl("/mention", { team: A, user: BOB, text: "what is up" });
  assert.equal(received.at(-1).event.type, "app_mention");
  await api(
    "chat.postMessage",
    { channel: "CA0000GENRL", text: "all good", thread_ts: mention.event.ts },
    token,
  );
  const posts = (await ctl(`/posts?team=${A}&channel=CA0000GENRL`)).posts;
  assert.equal(posts.at(-1).threadTs, mention.event.ts);
  const noScope = await api("conversations.history", { channel: "CA0000GENRL" }, token);
  assert.equal(noScope.error, "missing_scope");
  assert.equal(noScope.needed, "channels:history");
  const group = (await ctl(`/history?team=${A}&channel=general`)).messages;
  assert.deepEqual(
    group.map((m) => m.text),
    ["lunch?", "<@UBOTA0000AAAA> what is up", "all good"],
  );

  // A sign-in granting the scope adds it to the install, and keeps the token.
  const wider = await install(A, GUARDIAN, `${APP_SCOPES},channels:history`);
  assert.equal(wider.access_token, token);
  await sleep(450);
  const groupRead = await api("conversations.history", { channel: "CA0000GENRL" }, token);
  assert.equal(groupRead.ok, true);
  assert.equal(groupRead.messages[0].reply_count, 1);

  // Removing the app: the token is dead before either event arrives, so an app
  // that checks it on hearing of the removal finds it revoked.
  assert.equal((await ctl("/auth-test", { team: A })).auth_test.ok, true);
  const heard = {};
  onEvent = async (envelope) => {
    const type = envelope.event?.type;
    if (type === "tokens_revoked" || type === "app_uninstalled")
      heard[type] = (await api("auth.test", {}, token)).error;
  };
  const removed = await ctl("/uninstall", { team: A });
  onEvent = null;
  assert.equal(removed.ok, true);
  assert.deepEqual(heard, { tokens_revoked: "token_revoked", app_uninstalled: "token_revoked" });
  assert.equal((await api("auth.test", {}, token)).error, "token_revoked");
  const check = await ctl("/auth-test", { team: A });
  assert.equal(check.token_state, "revoked");
  assert.equal(check.auth_test.error, "token_revoked");
  assert.equal((await ctl("/dm", { team: A, user: BOB, text: "hello?" })).status, 409);

  // Installing again through the same sign-in: a new token, the same bot user.
  const back = await install(A, GUARDIAN, APP_SCOPES);
  assert.notEqual(back.access_token, token);
  assert.equal(back.bot_user_id, first.bot_user_id);
  assert.equal((await api("auth.test", {}, back.access_token)).user_id, first.bot_user_id);
  // What was said before the removal is still in Slack.
  await ctl("/config", { history_limit: false });
  const kept = await api("conversations.history", { channel: dm }, back.access_token);
  assert.equal(kept.messages.length, 20);

  // auth.revoke, as Rome's disconnect calls it, makes auth.test refuse the token.
  assert.equal((await api("auth.revoke", {}, back.access_token)).revoked, true);
  assert.equal((await ctl("/auth-test", { team: A })).auth_test.error, "token_revoked");
  assert.equal((await ctl("/state")).workspaces[0].token, "revoked");
});

test("an install without a scope gets no event that needs it", async () => {
  const B = "TB0000BBBB";
  await install(B, "UB0000GUARD", "chat:write");
  const refused = await ctl("/dm", { team: B, user: "UB0000ERIN1", text: "hi" });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /lacks im:history/);
  const denied = await api(
    "users.info",
    { user: "UB0000ERIN1" },
    (await install(B, "UB0000GUARD", "chat:write")).access_token,
  );
  assert.equal(denied.error, "missing_scope");
  assert.equal(denied.needed, "users:read");
});

test("a member's email shows only to an app granted users:read.email", async () => {
  const B = "TB0000BBBB";
  const plain = await install(B, "UB0000GUARD", "users:read");
  const without = await api("users.info", { user: "UB0000ERIN1" }, plain.access_token);
  assert.equal(without.ok, true);
  assert.equal("email" in without.user.profile, false);
  const granted = await install(B, "UB0000GUARD", "users:read,users:read.email");
  const withEmail = await api("users.info", { user: "UB0000ERIN1" }, granted.access_token);
  assert.match(withEmail.user.profile.email, /@/);
});

test("a message is in history before the app hears of it", async () => {
  const C = "TA0000AAAA";
  const { access_token: token } = await install(C, GUARDIAN, `${APP_SCOPES},channels:history`);
  await ctl("/config", { history_limit: false });
  let seen = null;
  onEvent = async (envelope) => {
    if (envelope.event?.type !== "app_mention") return;
    const { channel, ts } = envelope.event;
    seen = await api("conversations.replies", { channel, ts }, token);
    await api("chat.postMessage", { channel, text: "on it", thread_ts: ts }, token);
  };
  try {
    const mention = await ctl("/mention", { team: C, user: BOB, text: "before you answer" });
    assert.equal(seen.ok, true);
    assert.equal(seen.messages[0].ts, mention.event.ts);
    const thread = await api(
      "conversations.replies",
      { channel: "CA0000GENRL", ts: mention.event.ts },
      token,
    );
    assert.deepEqual(
      thread.messages.map((m) => m.text),
      ["<@UBOTA0000AAAA> before you answer", "on it"],
    );
    assert.equal(thread.messages[0].reply_count, 1);
  } finally {
    onEvent = null;
    await ctl("/config", { history_limit: true });
  }
});

test("a reset never lets a later message take an earlier one's ts", async () => {
  const C = "TA0000AAAA";
  await install(C, GUARDIAN, APP_SCOPES);
  const realNow = Date.now;
  const fixed = realNow();
  Date.now = () => fixed;
  try {
    const before = await ctl("/dm", { team: C, user: BOB, text: "before the reset" });
    await ctl("/reset", {});
    const after = await ctl("/dm", { team: C, user: BOB, text: "after the reset" });
    assert.notEqual(after.event.ts, before.event.ts);
    assert.ok(Number(after.event.ts) > Number(before.event.ts));
  } finally {
    Date.now = realNow;
  }
});

test("the app hears of its own post in a direct message, and history keeps mentions as messages", async () => {
  const C = "TA0000AAAA";
  const { access_token: token, bot_user_id: bot } = await install(C, GUARDIAN, APP_SCOPES);
  await ctl("/config", { history_limit: false });
  try {
    const dm = await ctl("/dm", { team: C, user: BOB, text: "ping" });
    const count = received.length;
    await api("chat.postMessage", { channel: dm.event.channel, text: "pong" }, token);
    for (let i = 0; i < 50 && received.length === count; i++) await sleep(10);
    const own = received.at(-1).event;
    assert.equal(own.type, "message");
    assert.equal(own.channel_type, "im");
    assert.equal(own.user, bot);
    assert.equal(own.bot_id, "BBOTA0000AAAA");
    assert.equal(own.text, "pong");
    // A post in a group sends nothing: the app subscribes to no group messages.
    const quiet = received.length;
    await api("chat.postMessage", { channel: "CA0000GENRL", text: "hello all" }, token);
    await sleep(100);
    assert.equal(received.length, quiet);
    // A mention is an ordinary message in the group's history.
    await install(C, GUARDIAN, `${APP_SCOPES},channels:history`);
    const mention = await ctl("/mention", { team: C, user: BOB, text: "typed" });
    const read = await api(
      "conversations.replies",
      { channel: "CA0000GENRL", ts: mention.event.ts },
      token,
    );
    assert.equal(read.messages[0].type, "message");
    assert.equal(read.messages[0].text, "<@UBOTA0000AAAA> typed");
    // oldest and latest bound every message of the thread, the parent too.
    const replyTs = (
      await api(
        "chat.postMessage",
        { channel: "CA0000GENRL", text: "answer", thread_ts: mention.event.ts },
        token,
      )
    ).ts;
    const after = await api(
      "conversations.replies",
      { channel: "CA0000GENRL", ts: mention.event.ts, oldest: mention.event.ts },
      token,
    );
    assert.deepEqual(
      after.messages.map((m) => m.ts),
      [replyTs],
    );
    const both = await api(
      "conversations.replies",
      { channel: "CA0000GENRL", ts: mention.event.ts, oldest: mention.event.ts, inclusive: true },
      token,
    );
    assert.deepEqual(
      both.messages.map((m) => m.ts),
      [mention.event.ts, replyTs],
    );
    const before = await api(
      "conversations.replies",
      { channel: "CA0000GENRL", ts: mention.event.ts, latest: replyTs },
      token,
    );
    assert.deepEqual(
      before.messages.map((m) => m.ts),
      [mention.event.ts],
    );
  } finally {
    await ctl("/config", { history_limit: true });
  }
});

test("without public distribution only the home workspace can approve the app", async () => {
  const C = "TC0000CCCC";
  const state = await ctl("/state");
  assert.equal(state.distribution.on, true);
  assert.equal(state.distribution.home_team, A);
  const approve = (team, user) =>
    fetch(`${base}/oauth/v2/authorize/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "111.222",
        scope: APP_SCOPES,
        redirect_uri: "http://cloud.test/cb",
        state: "s9",
        team,
        user,
        decision: "allow",
      }),
    });
  const since = state.seq;
  assert.equal((await ctl("/config", { distributed: false })).distributed, false);
  const refused = await approve(C, "UC0000OWNR1");
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /invalid_team_for_non_distributed_app/);
  assert.equal((await approve(A, GUARDIAN)).status, 302);
  assert.equal((await ctl("/config", { distributed: true })).distributed, true);
  const allowed = await approve(C, "UC0000OWNR1");
  assert.equal(allowed.status, 302);
  assert.ok(new URL(allowed.headers.get("location")).searchParams.get("code"));
  const { approvals } = await ctl(`/approvals?since=${since}`);
  assert.deepEqual(
    approvals.map((a) => [a.teamId, a.userId, a.outcome, a.error]),
    [
      [C, "UC0000OWNR1", "refused", "invalid_team_for_non_distributed_app"],
      [A, GUARDIAN, "approved", null],
      [C, "UC0000OWNR1", "approved", null],
    ],
  );
});

test("the connector's Web API methods check scope and token type, and every call is recorded", async () => {
  const C = "TC0000CCCC";
  const OWNER = "UC0000OWNR1";
  const HANK = "UC0000HANK1";
  await ctl("/config", { history_limit: false });
  const narrow = await install(C, OWNER, "chat:write", "");
  const bot = narrow.access_token;
  // A bot token without the scope: Slack's missing_scope, naming it.
  for (const [method, args, needed] of [
    ["conversations.list", {}, "channels:read"],
    ["conversations.list", { types: "im" }, "im:read"],
    ["conversations.info", { channel: "CC0000GENRL" }, "channels:read"],
    ["users.list", {}, "users:read"],
    [
      "reactions.add",
      { channel: "CC0000GENRL", timestamp: "1.1", name: "eyes" },
      "reactions:write",
    ],
  ]) {
    const r = await api(method, args, bot);
    if (method === "reactions.add") {
      assert.equal(r.error, "missing_scope", method);
    } else {
      assert.deepEqual([r.error, r.needed], ["missing_scope", needed], method);
    }
  }
  // A method a bot token can never call.
  assert.equal((await api("search.messages", { query: "x" }, bot)).error, "not_allowed_token_type");

  const wide = await install(
    C,
    OWNER,
    "chat:write,channels:read,groups:read,im:read,users:read,reactions:write,channels:history",
    "search:read",
  );
  assert.equal(wide.access_token, bot);
  const user = wide.authed_user.access_token;
  const said = await ctl("/group-message", {
    team: C,
    user: HANK,
    channel: "CC0000GENRL",
    text: "the blue door code",
  });
  const listed = await api("conversations.list", { types: "public_channel,im" }, bot);
  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.channels.map((c) => c.id),
    ["CC0000GENRL", "DC000C0000OWNR1", "DC000C0000HANK1"],
  );
  assert.equal(
    (await api("conversations.info", { channel: "CC0000GENRL" }, bot)).channel.name,
    "general",
  );
  const people = await api("users.list", { limit: 2 }, bot);
  assert.equal(people.members.length, 2);
  assert.ok(people.response_metadata.next_cursor);
  const rest = await api("users.list", { cursor: people.response_metadata.next_cursor }, bot);
  assert.deepEqual(
    rest.members.map((m) => m.id),
    [HANK],
  );
  const ts = said.event.ts;
  assert.equal(
    (await api("reactions.add", { channel: "CC0000GENRL", timestamp: ts, name: "eyes" }, bot)).ok,
    true,
  );
  assert.equal(
    (await api("reactions.add", { channel: "CC0000GENRL", timestamp: ts, name: "eyes" }, bot))
      .error,
    "already_reacted",
  );
  const history = await api("conversations.history", { channel: "CC0000GENRL" }, bot);
  assert.deepEqual(history.messages[0].reactions, [
    { name: "eyes", users: [narrow.bot_user_id], count: 1 },
  ]);
  // A user token: its own scopes, so search works and a write it was not granted does not.
  const found = await api("search.messages", { query: "blue door" }, user);
  assert.equal(found.ok, true);
  assert.equal(found.messages.total, 1);
  assert.equal(found.messages.matches[0].channel.id, "CC0000GENRL");
  assert.deepEqual(
    [(await api("chat.postMessage", { channel: "CC0000GENRL", text: "hi" }, user)).error],
    ["missing_scope"],
  );

  const { calls } = await ctl(`/calls?team=${C}&method=search.messages`);
  assert.deepEqual(
    calls.map((c) => [c.tokenKind, c.ok, c.error ?? null, c.scopes.join(",")]),
    [
      ["bot", false, "not_allowed_token_type", "chat:write"],
      ["user", true, null, "search:read"],
    ],
  );
  const refused = (await ctl(`/calls?team=${C}&method=users.list`)).calls[0];
  assert.equal(refused.needed, "users:read");
  await ctl("/config", { history_limit: true });
});

test("a group the bot is not in: no reads, posts or search hits from outside it", async () => {
  await ctl("/config", { history_limit: false });
  const granted = await install(
    A,
    GUARDIAN,
    `${APP_SCOPES},channels:read,channels:history`,
    "search:read",
  );
  const bot = granted.access_token;
  const user = granted.authed_user.access_token;
  assert.equal(
    (await api("conversations.history", { channel: "CA0000QUIET" }, bot)).error,
    "not_in_channel",
  );
  assert.equal(
    (await api("chat.postMessage", { channel: "CA0000QUIET", text: "hi" }, bot)).error,
    "not_in_channel",
  );
  const news = await api("conversations.history", { channel: "CA0000NEWS1" }, bot);
  assert.deepEqual(
    news.messages.map((m) => m.text),
    ["The tangerine kiosk opens on Fridays."],
  );
  const listed = await api("conversations.list", {}, bot);
  const member = Object.fromEntries(listed.channels.map((c) => [c.id, c.is_member]));
  assert.equal(member.CA0000QUIET, false);
  assert.equal(member.CA0000NEWS1, true);
  // The guardian is not in the group either, so their search never finds it.
  assert.equal((await api("search.messages", { query: "marmalade" }, user)).messages.total, 0);
  assert.equal((await api("search.messages", { query: "tangerine" }, user)).messages.total, 1);
  // chat:write.public lets a bot post in a public group it is not in.
  const wider = await install(A, GUARDIAN, `${APP_SCOPES},chat:write.public`);
  assert.equal(
    (await api("chat.postMessage", { channel: "CA0000QUIET", text: "hi" }, wider.access_token)).ok,
    true,
  );
  await ctl("/config", { history_limit: true });
});

test("older Slack apps an upgrade finds: a Socket Mode bot and Rome Cloud's OAuth app", async () => {
  const B = "TB0000BBBB";
  const bot = await ctl("/other-app", { team: B, kind: "socket_bot", name: "Rome Bot" });
  assert.equal(bot.kind, "socket_bot");
  assert.match(bot.bot_token, /^xoxb-/);
  assert.match(bot.app_token, /^xapp-/);
  assert.equal(
    (await ctl("/other-app", { team: B, kind: "socket_bot", name: "Rome Bot" })).bot_token,
    bot.bot_token,
  );

  // Its own identity, distinct from Rome's app.
  const who = await api("auth.test", {}, bot.bot_token);
  assert.deepEqual([who.user_id, who.bot_id, who.user], [bot.bot_user_id, bot.bot_id, "rome-bot"]);
  // auth.test names no app, so a bot reads its app from bots.info, by GET.
  const named = await (
    await fetch(`${base}/api/bots.info?bot=${who.bot_id}`, {
      headers: { authorization: `Bearer ${bot.bot_token}` },
    })
  ).json();
  assert.deepEqual([named.bot.app_id, named.bot.user_id], [bot.app_id, bot.bot_user_id]);
  assert.equal((await api("bots.info", { bot: "BNOPE" }, bot.bot_token)).error, "bot_not_found");
  // An app-level token opens Socket Mode and nothing else; a bot token cannot open it.
  assert.equal(
    (await api("apps.connections.open", {}, bot.bot_token)).error,
    "not_allowed_token_type",
  );
  assert.equal(
    (await api("chat.postMessage", { channel: "UB0000ERIN1", text: "x" }, bot.app_token)).error,
    "not_allowed_token_type",
  );
  const opened = await api("apps.connections.open", {}, bot.app_token);
  assert.match(opened.url, /^wss:\/\/wss-primary\.slack\.com\/link\/\?ticket=/);

  const url = new URL(opened.url);
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}${url.pathname}${url.search}`);
  const frames = [];
  ws.onmessage = (m) => {
    const frame = JSON.parse(m.data);
    frames.push(frame);
    if (frame.envelope_id) ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
  };
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  while (!frames.length) await sleep(10);
  assert.equal(frames[0].type, "hello");
  assert.equal(frames[0].connection_info.app_id, bot.app_id);
  // A used ticket does not open a second connection.
  const reused = new WebSocket(`ws://127.0.0.1:${new URL(base).port}${url.pathname}${url.search}`);
  await new Promise((r) => {
    reused.onerror = r;
    reused.onclose = r;
  });

  const event = {
    type: "message",
    channel_type: "im",
    channel: "DB000B0000ERIN1",
    user: "UB0000ERIN1",
    text: "hi bot",
    ts: "1700000001.000100",
  };
  const sent = await ctl("/socket-event", { app_id: bot.app_id, event });
  assert.equal(sent.acked, true);
  assert.equal(frames[1].type, "events_api");
  assert.equal(frames[1].payload.api_app_id, bot.app_id);
  assert.equal(frames[1].payload.event.text, "hi bot");

  const posted = await api(
    "chat.postMessage",
    { channel: "UB0000ERIN1", text: "from the old bot" },
    bot.bot_token,
  );
  assert.equal(posted.ok, true);
  const { posts } = await ctl(`/posts?team=${B}`);
  assert.deepEqual(
    [posts.at(-1).appId, posts.at(-1).user, posts.at(-1).text],
    [bot.app_id, bot.bot_user_id, "from the old bot"],
  );
  ws.close();
  for (let i = 0; i < 50 && (await ctl("/state")).open_sockets.length; i++) await sleep(10);
  const { sockets } = await ctl(`/sockets`);
  assert.deepEqual(
    sockets.filter((x) => x.appId === bot.app_id).map((x) => x.event),
    ["opened", "hello", "sent", "acked", "closed"],
  );

  // Rome Cloud's earlier OAuth app: a bot token and the installer's user token.
  const oauth = await ctl("/other-app", { team: B, kind: "oauth", name: "Rome" });
  assert.equal(oauth.app_token, null);
  assert.equal(oauth.installed_by, "UB0000GUARD");
  assert.equal(
    (await api("chat.postMessage", { channel: "CB0000GENRL", text: "old oauth" }, oauth.bot_token))
      .ok,
    true,
  );
  assert.equal(
    (await api("search.messages", { query: "old oauth" }, oauth.user_token)).messages.total,
    1,
  );
  const state = await ctl("/state");
  assert.deepEqual(
    state.other_apps.map((a) => [a.kind, a.bot_token_tail]),
    [
      ["socket_bot", bot.bot_token.slice(-6)],
      ["oauth", oauth.bot_token.slice(-6)],
    ],
  );
  assert.ok(!JSON.stringify(state).includes(oauth.bot_token));
  assert.equal(state.workspaces[1].bot_token_tail.length, 6);
});

test("removing the app revokes every token it issued, a repeated sign-in's older user token too", async () => {
  const C = "TC0000CCCC";
  const first = await install(C, "UC0000OWNR1", "chat:write", "search:read");
  const second = await install(C, "UC0000OWNR1", "chat:write", "search:read");
  assert.notEqual(first.authed_user.access_token, second.authed_user.access_token);
  const other = await ctl("/other-app", { team: C, kind: "oauth", name: "Rome Old" });
  await ctl("/uninstall", { team: C });
  for (const token of [
    first.access_token,
    first.authed_user.access_token,
    second.authed_user.access_token,
  ]) {
    assert.equal((await api("auth.test", {}, token)).error, "token_revoked");
  }
  // Another app's tokens are not Rome's app's to lose.
  assert.equal((await api("auth.test", {}, other.bot_token)).ok, true);
});

test("a user token reads only the private conversations its member is in", async () => {
  const C = "TC0000CCCC";
  const OWNER = "UC0000OWNR1";
  const HANK = "UC0000HANK1";
  const reads = "channels:history,groups:history,im:history";
  const owner = (await install(C, OWNER, "chat:write", reads)).authed_user.access_token;
  const hank = (await install(C, HANK, "chat:write", reads)).authed_user.access_token;
  const dms = (await ctl("/state")).workspaces.find((w) => w.id === C).members;
  const dmOf = (id) => dms.find((m) => m.id === id).im_channel;
  await ctl("/config", { history_limit: false });
  try {
    const read = async (method, channel, token) =>
      (await api(method, { channel, ts: "1700000000.000100" }, token)).error ?? "ok";
    // A member's own direct message with the bot, and nobody else's.
    assert.equal(await read("conversations.history", dmOf(OWNER), owner), "ok");
    assert.equal(await read("conversations.history", dmOf(HANK), owner), "channel_not_found");
    assert.equal(await read("conversations.replies", dmOf(HANK), owner), "channel_not_found");
    // A private group only for its members; a public one for everybody.
    assert.equal(await read("conversations.history", "GC0000BORD1", owner), "ok");
    assert.equal(await read("conversations.history", "GC0000BORD1", hank), "channel_not_found");
    assert.equal(await read("conversations.replies", "GC0000BORD1", hank), "channel_not_found");
    assert.equal(await read("conversations.history", "CC0000GENRL", hank), "ok");
    // Nor does a user token post into a conversation its member is not in.
    const post = async (channel, t) =>
      (await api("chat.postMessage", { channel, text: "hello" }, t)).error ?? "ok";
    const writer = (await install(C, HANK, "chat:write", `${reads},chat:write`)).authed_user
      .access_token;
    assert.equal(await post(dmOf(OWNER), writer), "channel_not_found");
    assert.equal(await post("GC0000BORD1", writer), "channel_not_found");
    assert.equal(await post(dmOf(HANK), writer), "ok");
    assert.equal(await post("CC0000GENRL", writer), "ok");
  } finally {
    await ctl("/config", { history_limit: true });
  }
});

test("the history limit holds per app: another app's read leaves Rome's quota alone", async () => {
  const token = (await install(A, GUARDIAN, APP_SCOPES)).access_token;
  const other = await ctl("/other-app", { team: A, kind: "socket_bot", name: "Quota Bot" });
  const dm = (await ctl("/state")).workspaces[0].members.find((m) => m.id === BOB).im_channel;
  await sleep(450);
  const read = async (t) => (await api("conversations.history", { channel: dm }, t)).error ?? "ok";
  assert.equal(await read(other.bot_token), "ok");
  assert.equal(await read(token), "ok");
  assert.equal(await read(other.bot_token), "ratelimited");
  assert.equal(await read(token), "ratelimited");
});

test("a private group is listed and described only to a token whose member is in it", async () => {
  const C = "TC0000CCCC";
  const scopes = "channels:read,groups:read";
  const owner = (await install(C, "UC0000OWNR1", "chat:write", scopes)).authed_user.access_token;
  const hank = (await install(C, "UC0000HANK1", "chat:write", scopes)).authed_user.access_token;
  const listed = async (t) =>
    (await api("conversations.list", { types: "public_channel,private_channel" }, t)).channels.map(
      (c) => c.id,
    );
  assert.deepEqual(await listed(owner), ["CC0000GENRL", "GC0000BORD1"]);
  assert.deepEqual(await listed(hank), ["CC0000GENRL"]);
  assert.equal((await api("conversations.info", { channel: "GC0000BORD1" }, owner)).ok, true);
  assert.equal(
    (await api("conversations.info", { channel: "GC0000BORD1" }, hank)).error,
    "channel_not_found",
  );
});

test("the channels option: users.conversations, and channel history and replies, by scope and membership", async () => {
  const CHANNEL_SCOPES = `${APP_SCOPES},channels:read,groups:read,channels:history,groups:history`;
  const token = (await install(A, GUARDIAN, CHANNEL_SCOPES)).access_token;
  const old = (await install("TB0000BBBB", "UB0000GUARD", APP_SCOPES)).access_token;
  const get = async (method, query, t) =>
    (
      await fetch(`${base}/api/${method}?${new URLSearchParams(query)}`, {
        headers: { authorization: `Bearer ${t}` },
      })
    ).json();
  await ctl("/config", { history_limit: false });
  try {
    const listed = await get(
      "users.conversations",
      { types: "public_channel,private_channel", exclude_archived: "true", limit: "200" },
      token,
    );
    assert.equal(listed.ok, true);
    // The bot is in general and news, not in quiet.
    assert.deepEqual(
      listed.channels.map((c) => [c.id, c.name, c.is_private]),
      [
        ["CA0000GENRL", "general", false],
        ["CA0000NEWS1", "news", false],
      ],
    );
    assert.equal(listed.response_metadata.next_cursor, "");
    const history = await get(
      "conversations.history",
      { channel: "CA0000NEWS1", limit: "15" },
      token,
    );
    assert.ok(history.messages.some((m) => m.text === "The tangerine kiosk opens on Fridays."));
    const replies = await get(
      "conversations.replies",
      { channel: "CA0000NEWS1", ts: "1700000000.000100", limit: "15" },
      token,
    );
    assert.equal(replies.messages[0].ts, "1700000000.000100");
    assert.equal(
      (await get("conversations.history", { channel: "CA0000QUIET" }, token)).error,
      "not_in_channel",
    );
    // A workspace installed with only the old scopes.
    assert.equal(
      (await get("users.conversations", { types: "public_channel,private_channel" }, old)).error,
      "missing_scope",
    );
    assert.equal(
      (await get("conversations.history", { channel: "CB0000GENRL" }, old)).error,
      "missing_scope",
    );
    assert.equal(
      (await get("conversations.replies", { channel: "CB0000GENRL", ts: "1" }, old)).error,
      "missing_scope",
    );
  } finally {
    await ctl("/config", { history_limit: true });
  }
});
