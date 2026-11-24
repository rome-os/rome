// A stand-in for the Rome instance, so the verifier can be proved before the
// product exists. It hears Slack's events from the fake Slack: a mention in a
// group, or a member's direct message. It answers in the place that asked:
// a code it was asked to say back, a fact it reads from the chat's or the
// thread's history (paced by Slack's limit, as the product must be), or work
// it hands off, logging the hand-off as the Concierge does, and posting the
// result when the work is done.
//
// Env: PORT, SLACK (the fake's origin), SIGNING_SECRET, TOKEN_FILE, BREAK,
// GENERAL, GUARDIAN, WORK_MS, POLL_MS. BREAK switches one promise off:
//   recall         reads #general once at start and answers from that, never at the mention
//   no-history     never reads the history: answers that it does not know
//   silence        also polls the history and answers any message naming it in plain text
//   stopped        answers only from what was said after it started
//   silent         never replies
//   guardian-only  answers only the guardian (GUARDIAN), as main does
//   last-chat      says a code back in the last group place a mention came from
//   same-answer    gives the same answer to the same question asked at the same moment
//   dm-in-shared   answers a direct message in #general
//   result-latest  posts work's result where the latest mention came from
//   no-handoff     does the work itself: no hand-off in its log

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const { PORT, SLACK, SIGNING_SECRET, TOKEN_FILE, BREAK = "", GENERAL, GUARDIAN } = process.env;
const WORK_MS = Number(process.env.WORK_MS ?? 2000);
const token = readFileSync(TOKEN_FILE, "utf8").trim();
const startedAt = Date.now() / 1000;
const log = (message, extra = {}) =>
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), message, ...extra })}\n`,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, args) {
  const res = await fetch(`${SLACK}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return {
    status: res.status,
    retryAfter: Number(res.headers.get("retry-after") ?? 0),
    body: await res.json(),
  };
}

/** A chat's latest messages, or a thread's, waiting out Slack's limit when it refuses. */
async function history(channel, threadTs) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = threadTs
      ? await api("conversations.replies", { channel, ts: threadTs, limit: 15 })
      : await api("conversations.history", { channel, limit: 15 });
    if (r.status === 429) {
      await sleep((r.retryAfter || 1) * 1000);
      continue;
    }
    if (!r.body.ok) throw new Error(`history read: ${r.body.error}`);
    return r.body.messages;
  }
  throw new Error("history read: still rate limited");
}

const said = (messages) => messages.filter((m) => !m.bot_id && !String(m.text).includes("<@UBOT"));
const words = (text) =>
  new Set(
    String(text)
      .toLowerCase()
      .match(/[a-z]{4,}/g) ?? [],
  );

/** The message that shares the most words with the question, the newest on a tie. */
function bestMatch(messages, question) {
  const q = words(question);
  let best = null;
  let score = 0;
  for (const m of [...messages].sort((a, b) => Number(a.ts) - Number(b.ts))) {
    const s = [...words(m.text)].filter((w) => q.has(w)).length;
    if (s >= score && s > 0) {
      best = m;
      score = s;
    }
  }
  return best;
}

let remembered = [];
let lastPlace = null;
const pending = new Map();

async function post(place, text) {
  await api("chat.postMessage", {
    channel: place.channel,
    text,
    ...(place.threadTs ? { thread_ts: place.threadTs } : {}),
  });
}

async function factAnswer(place, question) {
  let messages;
  if (BREAK === "no-history") messages = [];
  else if (BREAK === "recall") messages = remembered;
  else messages = await history(place.channel, place.threadTs);
  if (BREAK === "stopped") messages = messages.filter((m) => Number(m.ts) >= startedAt);
  const m = bestMatch(said(messages), question);
  return m ? `From the chat: ${m.text}` : "I don't know.";
}

async function answer(event, dm) {
  if (BREAK === "silent") return;
  if (BREAK === "guardian-only" && event.user !== GUARDIAN) return;
  const text = String(event.text).replace(/<@[A-Z0-9]+>\s*/g, "");
  const place = { channel: event.channel, threadTs: event.thread_ts ?? null };
  if (!dm) lastPlace = place;
  const work = text.match(/multiply (\d+) by (\d+).* as ([A-Z]+)-/);
  const code = text.match(/\b([A-Z]+-\d{4,})\b/);
  if (work) {
    if (BREAK !== "no-handoff")
      log("executing Rome tool", { component: "concierge-tools", data: { tool: "chat_start" } });
    await post(place, "On it: I started a task for that.");
    await sleep(WORK_MS);
    await post(
      BREAK === "result-latest" ? lastPlace : place,
      `Done: ${work[3]}-${Number(work[1]) * Number(work[2])}`,
    );
  } else if (code) {
    if (BREAK === "last-chat" && !dm) await sleep(300);
    const where = dm
      ? BREAK === "dm-in-shared"
        ? { channel: GENERAL, threadTs: null }
        : place
      : BREAK === "last-chat"
        ? lastPlace
        : place;
    await post(where, `Got it: ${code[1]}`);
  } else {
    let reply;
    if (BREAK === "same-answer" && pending.has(text)) reply = await pending.get(text);
    else {
      const p = factAnswer(place, text);
      if (BREAK === "same-answer") {
        pending.set(text, p);
        setTimeout(() => pending.delete(text), 5000);
      }
      reply = await p;
    }
    await post(place, reply);
  }
  log("answered", { channel: event.channel, ts: event.ts });
}

function verified(req, raw) {
  const ts = req.headers["x-slack-request-timestamp"];
  const sig = String(req.headers["x-slack-signature"] ?? "");
  const want = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`;
  return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

createServer(async (req, res) => {
  if (req.url === "/health") return res.end('{"ok":true}');
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (req.url !== "/events" || !verified(req, raw)) {
    res.statusCode = 401;
    return res.end();
  }
  const body = JSON.parse(raw);
  if (body.type === "url_verification")
    return res.end(JSON.stringify({ challenge: body.challenge }));
  res.end();
  const e = body.event ?? {};
  const fail = (error) => log("answer failed", { error: error.message });
  if (e.type === "app_mention") answer(e, false).catch(fail);
  else if (e.type === "message" && e.channel_type === "im" && !e.bot_id && !e.subtype)
    answer(e, true).catch(fail);
}).listen(Number(PORT), "127.0.0.1", () => log("stand-in listening", { port: PORT, break: BREAK }));

if (BREAK === "recall") {
  history(GENERAL).then(
    (m) => {
      remembered = m;
    },
    (e) => log("catch-up failed", { error: e.message }),
  );
}

if (BREAK === "silence") {
  const answeredTs = new Set();
  (async () => {
    for (;;) {
      await sleep(Number(process.env.POLL_MS ?? 3000));
      try {
        for (const m of said(await history(GENERAL))) {
          if (/rome/i.test(m.text) && !answeredTs.has(m.ts)) {
            answeredTs.add(m.ts);
            await post({ channel: GENERAL, threadTs: null }, "Did someone ask for me?");
          }
        }
      } catch (e) {
        log("poll failed", { error: e.message });
      }
    }
  })();
}
