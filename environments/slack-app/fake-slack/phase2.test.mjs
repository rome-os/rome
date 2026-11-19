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

async function install(team, user, scopes) {
  const approve = await fetch(`${base}/oauth/v2/authorize/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "111.222",
      scope: scopes,
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

  // Removing the app: both events, then the token fails, and auth-test says so.
  assert.equal((await ctl("/auth-test", { team: A })).auth_test.ok, true);
  const removed = await ctl("/uninstall", { team: A });
  assert.equal(removed.ok, true);
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
