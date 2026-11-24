// What the fake Slack offers the ambient agent's rules 5 to 8: five shared
// groups with the bot and four members who are not the guardian, mentions
// and direct messages from each, a batch delivered at one moment, the posts
// record, and reads of a group and a thread under the history limit.
// Run: node --test environments/slack-app/fake-slack/
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, start } from "./server.mjs";

const APP_SCOPES =
  "app_mentions:read,channels:history,channels:read,chat:write,im:history,im:read,im:write,users:read";
const A = "TA0000AAAA";
const GUARDIAN = "UA0000GUARD";
const MEMBERS = ["UA0000BOB01", "UA0000CARA1", "UA0000DAVE1", "UA0000EMMA1"];
const GROUPS = ["CA0000GENRL", "CA0000NEWS1", "CA0000DSGN1", "CA0000OPS01", "CA0000SALES"];
const received = [];
// Set by a test to hold acknowledgements, as a slow app would.
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
      authorization: `Bearer ${token}`,
    },
    body: new URLSearchParams(args),
  });
  return { status: res.status, ...(await res.json()) };
}

async function ctl(path, body) {
  const res = await fetch(`${base}/_control${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json()) };
}

async function install() {
  const approve = await fetch(`${base}/oauth/v2/authorize/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "111.222",
      scope: APP_SCOPES,
      redirect_uri: "http://cloud.test/cb",
      team: A,
      user: GUARDIAN,
      decision: "allow",
    }),
  });
  const code = new URL(approve.headers.get("location")).searchParams.get("code");
  return (await api("oauth.v2.access", { client_id: "111.222", client_secret: "c", code }))
    .access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("ambient: groups, members, a batch at one moment, posts, and limited reads", async () => {
  const token = await install();
  const state = await ctl("/state");
  const acme = state.workspaces.find((w) => w.id === A);

  // Five shared groups hold the bot, the guardian and the four members.
  for (const id of GROUPS) {
    const group = acme.groups.find((g) => g.id === id);
    assert.ok(group, id);
    assert.equal(group.bot_member, true, id);
    for (const m of [GUARDIAN, ...MEMBERS]) assert.ok(group.members.includes(m), `${m} in ${id}`);
  }

  // Each member mentions the bot in a group and in a thread there, and
  // writes it a direct message; Slack sends app_mention and message.im.
  for (const [i, user] of MEMBERS.entries()) {
    const channel = GROUPS[i];
    const top = await ctl("/mention", { team: A, user, channel, text: `top ${i}` });
    assert.equal(top.event_sent, true);
    assert.equal(received.at(-1).event.type, "app_mention");
    assert.equal(received.at(-1).event.user, user);
    assert.equal(received.at(-1).event.channel, channel);
    const inThread = await ctl("/mention", {
      team: A,
      user,
      channel,
      text: `reply ${i}`,
      thread_ts: top.ts,
    });
    assert.equal(received.at(-1).event.thread_ts, top.ts);
    assert.equal(inThread.event.thread_ts, top.ts);
    const dm = await ctl("/dm", { team: A, user, text: `private ${i}` });
    assert.equal(dm.event_sent, true);
    assert.equal(received.at(-1).event.type, "message");
    assert.equal(received.at(-1).event.channel_type, "im");
    const member = acme.members.find((m) => m.id === user);
    assert.equal(received.at(-1).event.channel, member.im_channel);
  }

  // A batch: ten mentions and two direct messages, whose events go out at
  // once. The app holds every acknowledgement until all twelve arrived, so a
  // batch that waited on one delivery before the next would never finish.
  const items = [];
  for (let i = 0; i < 10; i++) {
    items.push({
      kind: "mention",
      team: A,
      user: MEMBERS[i % 4],
      channel: GROUPS[i % 5],
      text: `q${i}`,
    });
  }
  items.push({ kind: "dm", team: A, user: MEMBERS[0], text: "dm a" });
  items.push({ kind: "dm", team: A, user: MEMBERS[1], text: "dm b" });
  items.push({
    kind: "group-message",
    team: A,
    user: MEMBERS[2],
    channel: GROUPS[2],
    text: "aside",
  });
  const before = received.length;
  let release;
  const all = new Promise((r) => {
    release = r;
  });
  onEvent = async () => {
    if (received.length - before >= 12) release();
    await all;
  };
  const batch = await ctl("/batch", { items });
  onEvent = null;
  assert.equal(batch.ok, true);
  assert.equal(batch.results.length, 13);
  assert.equal(received.length - before, 12);
  assert.deepEqual(
    batch.results.map((r) => r.event_sent),
    [...Array(12).fill(true), false],
  );
  for (const r of batch.results.slice(0, 12)) assert.equal(r.delivery.status, 200);
  // Each message took its ts in the order given.
  const tss = batch.results.map((r) => Number(r.ts));
  assert.deepEqual(
    [...tss].sort((x, y) => x - y),
    tss,
  );
  assert.equal(new Set(tss).size, tss.length);
  // The group message stays in history without an event.
  assert.ok(
    (await ctl(`/history?team=${A}&channel=${GROUPS[2]}`)).messages.some((m) => m.text === "aside"),
  );
  // A bad item refuses the batch before anything is sent.
  const refused = await ctl("/batch", { items: [{ kind: "shout", team: A, user: MEMBERS[0] }] });
  assert.equal(refused.status, 400);

  // Posts: the chat, the thread and the text of what the app sent, in a
  // group, in a thread there, and in a direct message.
  const mark = (await ctl("/posts")).seq;
  const dmChannel = acme.members.find((m) => m.id === MEMBERS[3]).im_channel;
  const threadTs = batch.results[0].ts;
  assert.equal(
    (await api("chat.postMessage", { channel: GROUPS[1], text: "in group" }, token)).ok,
    true,
  );
  assert.equal(
    (
      await api(
        "chat.postMessage",
        { channel: GROUPS[0], text: "in thread", thread_ts: threadTs },
        token,
      )
    ).ok,
    true,
  );
  assert.equal(
    (await api("chat.postMessage", { channel: dmChannel, text: "in dm" }, token)).ok,
    true,
  );
  const posts = (await ctl(`/posts?team=${A}&since=${mark}`)).posts;
  assert.deepEqual(
    posts.map((p) => [p.channel, p.threadTs, p.text]),
    [
      [GROUPS[1], null, "in group"],
      [GROUPS[0], threadTs, "in thread"],
      [dmChannel, null, "in dm"],
    ],
  );
  assert.deepEqual(
    (await ctl(`/posts?team=${A}&channel=${GROUPS[0]}&thread_ts=${threadTs}`)).posts.map(
      (p) => p.text,
    ),
    ["in thread"],
  );

  // Reads under the limit: a group's top-level messages newest first, at
  // most 15, once a window per method; a thread oldest first, its own window.
  for (let i = 0; i < 20; i++) {
    await ctl("/group-message", {
      team: A,
      user: MEMBERS[i % 4],
      channel: GROUPS[4],
      text: `chatter ${i}`,
    });
  }
  await sleep(450);
  const history = await api("conversations.history", { channel: GROUPS[4], limit: 100 }, token);
  assert.equal(history.ok, true);
  assert.equal(history.messages.length, 15);
  assert.equal(history.messages[0].text, "chatter 19");
  assert.equal(history.has_more, true);
  const thread = await api("conversations.replies", { channel: GROUPS[0], ts: threadTs }, token);
  assert.equal(thread.ok, true);
  assert.deepEqual(
    thread.messages.map((m) => m.text),
    [`<@${acme.bot.botUserId}> q0`, "in thread"],
  );
  const again = await api("conversations.history", { channel: GROUPS[4] }, token);
  assert.equal(again.status, 429);
  assert.equal(again.error, "ratelimited");
});
