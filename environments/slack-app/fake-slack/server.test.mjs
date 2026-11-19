// Run: node --test environments/slack-app/fake-slack/
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, slackSignature, start } from "./server.mjs";

const SIGNING_SECRET = "test-signing-secret";
const received = [];
let receiverStatus = 200;
let receiver;
let fake;
let base;

before(async () => {
  receiver = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(receiverStatus).end("ok");
  }).listen(0);
  await new Promise((r) => receiver.once("listening", r));
  const config = loadConfig({
    port: 0,
    workspacesFile: fileURLToPath(new URL("../config/workspaces.json", import.meta.url)),
    signingSecret: SIGNING_SECRET,
    clientSecret: "test-client-secret",
    clientId: "111.222",
    eventsUrl: `http://127.0.0.1:${receiver.address().port}/events`,
    retryDelaysMs: "50,50",
  });
  fake = start(config);
  await new Promise((r) => fake.servers[0].once("listening", r));
  base = `http://127.0.0.1:${fake.servers[0].address().port}`;
});

after(() => {
  receiver.close();
  for (const s of fake.servers) s.close();
});

const api = async (method, args, token) =>
  (
    await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: new URLSearchParams(args),
    })
  ).json();

const ctl = async (path, body) =>
  (
    await fetch(`${base}/_control${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
  ).json();

async function install(team, user) {
  const page = await fetch(
    `${base}/oauth/v2/authorize?client_id=111.222&scope=chat:write,im:history&redirect_uri=http://cloud.test/cb&state=s1&team=${team}`,
  );
  assert.equal(page.status, 200);
  assert.match(await page.text(), /requesting permission/);
  const approve = await fetch(`${base}/oauth/v2/authorize/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "111.222",
      scope: "chat:write,im:history",
      redirect_uri: "http://cloud.test/cb",
      state: "s1",
      team,
      user,
      decision: "allow",
    }),
  });
  assert.equal(approve.status, 302);
  const location = new URL(approve.headers.get("location"));
  assert.equal(location.searchParams.get("state"), "s1");
  const code = location.searchParams.get("code");
  const res = await api("oauth.v2.access", {
    client_id: "111.222",
    client_secret: "test-client-secret",
    code,
    redirect_uri: "http://cloud.test/cb",
  });
  assert.equal(res.ok, true);
  const reuse = await api("oauth.v2.access", {
    client_id: "111.222",
    client_secret: "test-client-secret",
    code,
  });
  assert.equal(reuse.error, "invalid_code");
  return res;
}

test("sign-in, Web API, signed events, uninstall", async () => {
  const a = await install("TA0000AAAA", "UA0000GUARD");
  assert.equal(a.team.id, "TA0000AAAA");
  assert.match(a.access_token, /^xoxb-/);

  const who = await api("auth.test", {}, a.access_token);
  assert.equal(who.ok, true);
  assert.equal(who.team_id, "TA0000AAAA");
  assert.equal(who.user_id, a.bot_user_id);
  assert.equal((await api("auth.test", {}, "xoxb-nope")).error, "invalid_auth");

  const user = await api("users.info", { user: "UA0000BOB01" }, a.access_token);
  assert.equal(user.user.real_name, "Bob Member");
  assert.equal(
    (await api("users.info", { user: "UB0000GUARD" }, a.access_token)).error,
    "user_not_found",
  );

  // A direct message arrives signed with Slack's scheme.
  const dm = await ctl("/dm", { team: "TA0000AAAA", user: "UA0000BOB01", text: "hello" });
  assert.equal(dm.delivery.status, 200);
  const got = received.at(-1);
  const ts = got.headers["x-slack-request-timestamp"];
  assert.equal(got.headers["x-slack-signature"], slackSignature(SIGNING_SECRET, ts, got.body));
  const envelope = JSON.parse(got.body);
  assert.equal(envelope.event.type, "message");
  assert.equal(envelope.event.channel_type, "im");
  assert.equal(envelope.team_id, "TA0000AAAA");

  // The bot answers in the same direct message.
  const open = await api("conversations.open", { users: "UA0000BOB01" }, a.access_token);
  assert.equal(open.channel.id, envelope.event.channel);
  const post = await api(
    "chat.postMessage",
    { channel: envelope.event.channel, text: "hi bob" },
    a.access_token,
  );
  assert.equal(post.ok, true);
  const posts = await ctl(`/posts?team=TA0000AAAA&channel=${envelope.event.channel}`);
  assert.deepEqual(
    posts.posts.map((p) => p.text),
    ["hi bob"],
  );
  // A token from workspace A cannot post into workspace B's conversations.
  const otherDm = (await ctl("/state")).workspaces[1].members[0].im_channel;
  assert.equal(
    (await api("chat.postMessage", { channel: otherDm, text: "x" }, a.access_token)).error,
    "channel_not_found",
  );

  // Forged events carry a signature that does not verify.
  const forged = await ctl("/forged", { team: "TA0000AAAA", user: "UA0000BOB01", text: "evil" });
  const bad = received.at(-1);
  assert.equal(forged.delivery.signature, "bad_signature");
  assert.notEqual(
    bad.headers["x-slack-signature"],
    slackSignature(SIGNING_SECRET, bad.headers["x-slack-request-timestamp"], bad.body),
  );

  // A mention in a group.
  const mention = await ctl("/mention", {
    team: "TA0000AAAA",
    user: "UA0000CARA1",
    channel: "general",
    text: "hey",
  });
  assert.equal(mention.event.type, "app_mention");
  assert.match(mention.event.text, /^<@UBOT/);

  // A workspace without the app gets no events.
  const res = await fetch(`${base}/_control/dm`, {
    method: "POST",
    body: JSON.stringify({ team: "TB0000BBBB", user: "UB0000GUARD", text: "x" }),
  });
  assert.equal(res.status, 409);

  // Every call was recorded.
  const calls = await ctl("/calls?team=TA0000AAAA");
  assert.ok(calls.calls.some((c) => c.method === "chat.postMessage"));

  // Removing the app sends both events and the bot token stops working.
  const removed = await ctl("/uninstall", { team: "TA0000AAAA" });
  assert.equal(removed.app_uninstalled.event.type, "app_uninstalled");
  assert.equal(removed.tokens_revoked.event.type, "tokens_revoked");
  assert.equal((await api("auth.test", {}, a.access_token)).error, "token_revoked");

  // Reinstalling issues a new token.
  const again = await install("TA0000AAAA", "UA0000GUARD");
  assert.notEqual(again.access_token, a.access_token);
  assert.equal((await api("auth.test", {}, again.access_token)).ok, true);

  // auth.revoke ends the token, and a new sign-in gets a working one.
  assert.equal((await api("auth.revoke", {}, again.access_token)).revoked, true);
  assert.equal((await api("auth.test", {}, again.access_token)).error, "token_revoked");
  const third = await install("TA0000AAAA", "UA0000GUARD");
  assert.notEqual(third.access_token, again.access_token);
  assert.equal((await api("auth.test", {}, third.access_token)).ok, true);

  // The official app replies with markdown_text and no text, as a JSON body.
  const md = await (
    await fetch(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${third.access_token}`,
      },
      body: JSON.stringify({ channel: envelope.event.channel, markdown_text: "**hi** bob" }),
    })
  ).json();
  assert.equal(md.ok, true);
  const mdPost = (await ctl(`/posts?channel=${envelope.event.channel}`)).posts.at(-1);
  assert.equal(mdPost.text, "**hi** bob");
  assert.equal(mdPost.markdownText, "**hi** bob");
});

test("a failed delivery is retried with Slack's retry headers", async () => {
  await install("TB0000BBBB", "UB0000GUARD");
  receiverStatus = 500;
  const before = received.length;
  const dm = await ctl("/dm", { team: "TB0000BBBB", user: "UB0000ERIN1", text: "retry me" });
  assert.equal(dm.delivery.status, 500);
  await new Promise((r) => setTimeout(r, 300));
  receiverStatus = 200;
  const attempts = received
    .slice(before)
    .filter((r) => JSON.parse(r.body).event_id === dm.event_id);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[2].headers["x-slack-retry-num"], "2");
});
