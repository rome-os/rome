import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPage, looksLikeInstallLink } from "./lib/approval-page.mjs";
import {
  entryApprovalPage,
  entryDirectMessage,
  entryMention,
  findRomeBot,
  ROME_APP_ID,
} from "./lib/entries.mjs";

const BOT = { id: "UBOT", bot_id: "BBOT" };

// A stub Slack workspace: `replyAfterMs` decides whether and when the bot answers.
function stubSlack({
  installed = true,
  botInChannel = true,
  replyAfterMs = null,
  replyInThread = false,
} = {}) {
  const clock = { t: 0 };
  const posted = [];
  const members = [
    { id: "UTESTER", profile: {} },
    ...(installed
      ? [{ id: BOT.id, profile: { api_app_id: ROME_APP_ID, bot_id: BOT.bot_id } }]
      : []),
  ];
  const botMessages = (channel, threadOnly) => {
    const sent = posted.find((p) => p.channel === channel);
    if (!sent || replyAfterMs === null || clock.t < replyAfterMs) return [];
    if (replyInThread !== threadOnly) return [];
    return [{ ts: String(Number(sent.ts) + 1), user: BOT.id, bot_id: BOT.bot_id }];
  };
  const slack = {
    posted,
    async call(method, a) {
      switch (method) {
        case "users.list":
          return a.cursor
            ? { members: members.slice(1) }
            : { members: members.slice(0, 1), response_metadata: { next_cursor: "p2" } };
        case "conversations.open":
          return { channel: { id: "DBOT" } };
        case "users.conversations":
          return { channels: [{ id: "CNOBOT" }, { id: "CSHARED" }] };
        case "conversations.members":
          return {
            members: a.channel === "CSHARED" && botInChannel ? ["UTESTER", BOT.id] : ["UTESTER"],
          };
        case "chat.postMessage": {
          const ts = `1700000000.${String(posted.length + 1).padStart(6, "0")}`;
          posted.push({ channel: a.channel, text: a.text, ts });
          return { ts };
        }
        case "conversations.history":
          return {
            messages: [
              { ts: posted.at(-1)?.ts, user: "UTESTER" },
              ...botMessages(a.channel, false),
            ],
          };
        case "conversations.replies":
          return { messages: botMessages(a.channel, true) };
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  const opts = {
    windowMs: 60_000,
    pollMs: 3_000,
    now: () => clock.t,
    sleep: async (ms) => void (clock.t += ms),
  };
  return { slack, opts };
}

test("findRomeBot reads every page of users.list and matches the app id", async () => {
  assert.deepEqual((await findRomeBot(stubSlack().slack)).bot, BOT);
  assert.equal((await findRomeBot(stubSlack({ installed: false }).slack)).bot, null);
});

test("entries 2 and 3 are not checked and send nothing when the app is not installed", async () => {
  const { slack, opts } = stubSlack({ installed: false });
  const { bot } = await findRomeBot(slack);
  for (const entry of [entryDirectMessage, entryMention]) {
    const r = await entry({ slack, bot, nonce: "n1", ...opts });
    assert.equal(r.verdict, "not checked");
    assert.equal(r.reason, "app not installed");
  }
  assert.equal(slack.posted.length, 0);
});

test("a direct message passes on a bot reply inside 60 s and fails without one", async () => {
  let s = stubSlack({ replyAfterMs: 9_000 });
  let r = await entryDirectMessage({ slack: s.slack, bot: BOT, nonce: "n1", ...s.opts });
  assert.equal(r.verdict, "pass");
  assert.equal(s.slack.posted.length, 1);
  assert.equal(s.slack.posted[0].text, "[rubric check] n1");

  s = stubSlack({ replyAfterMs: 61_000 });
  r = await entryDirectMessage({ slack: s.slack, bot: BOT, nonce: "n1", ...s.opts });
  assert.equal(r.verdict, "fail");
  assert.equal(s.slack.posted.length, 1);
});

test("a mention passes on a reply in the thread or in the channel, in the channel the bot is in", async () => {
  for (const replyInThread of [true, false]) {
    const s = stubSlack({ replyAfterMs: 3_000, replyInThread });
    const r = await entryMention({ slack: s.slack, bot: BOT, nonce: "n2", ...s.opts });
    assert.equal(r.verdict, "pass");
    assert.deepEqual(
      s.slack.posted.map((p) => [p.channel, p.text]),
      [["CSHARED", "[rubric check] <@UBOT> n2"]],
    );
  }
});

test("a mention is not checked when the bot shares no channel with the tester", async () => {
  const s = stubSlack({ botInChannel: false });
  const r = await entryMention({ slack: s.slack, bot: BOT, nonce: "n2", ...s.opts });
  assert.equal(r.verdict, "not checked");
  assert.equal(s.slack.posted.length, 0);
});

test("entry 1 is not checked without a Rome-produced link and never loads a page", async () => {
  let loaded = false;
  const r = await entryApprovalPage({
    installLink: async () => ({ link: null, reason: "no instance signer JWT" }),
    loadPage: async () => void (loaded = true),
  });
  assert.equal(r.verdict, "not checked");
  assert.equal(loaded, false);
});

test("entry 1 scores the page Slack showed", async () => {
  const link =
    "https://slack.com/oauth/v2/authorize?client_id=1.2&state=s&redirect_uri=https%3A%2F%2Fromeos.cc%2Fcb";
  const score = (seen) =>
    entryApprovalPage({
      installLink: async () => ({ link, source: "stub" }),
      loadPage: async () => ({ status: 200, ms: 1, ...seen }),
    });
  const oauth = "https://acme.slack.com/oauth?client_id=1.2";
  assert.equal(
    (await score({ url: oauth, title: "Rome is requesting permission", hasAllow: true })).verdict,
    "pass",
  );
  assert.equal(
    (await score({ url: oauth, title: "Slack", text: "Invalid client_id parameter" })).verdict,
    "fail",
  );
  assert.equal(
    (await score({ url: oauth, title: "Slack", text: "Something went wrong" })).verdict,
    "fail",
  );
  assert.equal(
    (await score({ url: "https://slack.com/signin", title: "Sign in | Slack" })).verdict,
    "not checked",
  );
});

test("entry 1 fails when Rome Cloud's answer is not an install link", async () => {
  const r = await entryApprovalPage({
    installLink: async () => ({ link: "https://example.com/", source: "stub" }),
    loadPage: async () => assert.fail("must not load"),
  });
  assert.equal(r.verdict, "fail");
});

test("classifyPage and looksLikeInstallLink", () => {
  assert.equal(
    classifyPage({ url: "https://slack.com/oauth/v2/authorize", title: "Error", hasAllow: true }),
    "error",
  );
  assert.equal(
    looksLikeInstallLink("https://slack.com/oauth/v2/authorize?client_id=1&state=s"),
    false,
  );
});
