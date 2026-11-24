// The three rubric entries for the official Slack app, scored against real
// Slack. Each entry resolves to { id, verdict, reason, evidence }, where
// verdict is "pass", "fail" or "not checked". Evidence holds ts values,
// status codes, timings and page titles only: never a token, a cookie or a
// message body beyond the nonce.

import { classifyPage, looksLikeInstallLink } from "./approval-page.mjs";
import { allPages } from "./slack.mjs";

export const ROME_APP_ID = "A0BEGBH132L";
export const PREFIX = "[rubric check]";

const pass = (id, reason, evidence) => ({ id, verdict: "pass", reason, evidence });
const fail = (id, reason, evidence) => ({ id, verdict: "fail", reason, evidence });
const notChecked = (id, reason, evidence = {}) => ({
  id,
  verdict: "not checked",
  reason,
  evidence,
});

/**
 * Entry 1: Rome's "Add Slack" link arrives at Slack's approval page.
 * `installLink()` must return a link Rome Cloud produced, or null with a
 * reason when there is no way to get one; this entry never builds the link.
 */
export async function entryApprovalPage({ installLink, loadPage }) {
  const id = "approval-page";
  const got = await installLink();
  if (!got.link) return notChecked(id, got.reason);
  if (!looksLikeInstallLink(got.link))
    return fail(id, "Rome Cloud's answer is not a Slack OAuth authorize link", {
      source: got.source,
    });
  const seen = await loadPage(got.link);
  const kind = classifyPage(seen);
  const evidence = {
    source: got.source,
    status: seen.status,
    title: seen.title,
    final_host: new URL(seen.url).host,
    ms: seen.ms,
  };
  if (kind === "approve") return pass(id, "Slack showed the approval page with Allow", evidence);
  if (kind === "signed-out")
    return notChecked(id, "Slack asked to sign in: the d cookie holds no session", evidence);
  if (kind === "invalid-client")
    return fail(id, "Slack answered Invalid client_id parameter", evidence);
  return fail(id, "Slack showed a page that is not the approval page", evidence);
}

/** The Rome bot's user in the tester's workspace, or null when the app is not installed. */
export async function findRomeBot(slack, appId = ROME_APP_ID) {
  const members = await allPages(slack, "users.list", {}, "members");
  const bot = members.find((m) => m.profile?.api_app_id === appId && !m.deleted);
  return {
    bot: bot ? { id: bot.id, bot_id: bot.profile?.bot_id, app_id: appId } : null,
    scanned: members.length,
    removed: members.some((m) => m.profile?.api_app_id === appId && m.deleted),
  };
}

const isFromBot = (message, bot) =>
  message.user === bot.id ||
  (bot.bot_id && message.bot_id === bot.bot_id) ||
  (bot.app_id && message.app_id === bot.app_id);

/** Polls `read()` until it yields a message after `afterTs` from the bot, or the window closes. */
async function waitForBotMessage({ read, bot, afterTs, windowMs, pollMs, now, sleep }) {
  const started = now();
  while (now() - started <= windowMs) {
    const messages = await read();
    const reply = messages.find((m) => Number(m.ts) > Number(afterTs) && isFromBot(m, bot));
    if (reply) return { ts: reply.ts, after_ms: now() - started };
    await sleep(pollMs);
  }
  return null;
}

const timing = (opts) => ({
  windowMs: opts.windowMs ?? 60_000,
  pollMs: opts.pollMs ?? 3_000,
  now: opts.now ?? Date.now,
  sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
});

/** Entry 2: a direct message to the Rome bot gets a reply within the window. */
export async function entryDirectMessage({ slack, bot, nonce, ...opts }) {
  const id = "direct-message";
  if (!bot) return notChecked(id, "app not installed");
  const t = timing(opts);
  const { channel } = await slack.call("conversations.open", { users: bot.id });
  const sent = await slack.call("chat.postMessage", {
    channel: channel.id,
    text: `${PREFIX} ${nonce}`,
  });
  const read = async () =>
    (await slack.call("conversations.history", { channel: channel.id, oldest: sent.ts, limit: 50 }))
      .messages ?? [];
  const reply = await waitForBotMessage({ read, bot, afterTs: sent.ts, ...t });
  const evidence = { nonce, sent_ts: sent.ts, window_ms: t.windowMs };
  if (reply)
    return pass(id, "the bot replied in the direct message", {
      ...evidence,
      reply_ts: reply.ts,
      after_ms: reply.after_ms,
    });
  return fail(id, `no reply from the bot within ${t.windowMs / 1000} s`, evidence);
}

/** Entry 3: a message mentioning the bot in a shared channel the bot is in gets a reply. */
export async function entryMention({ slack, bot, nonce, ...opts }) {
  const id = "mention";
  if (!bot) return notChecked(id, "app not installed");
  const t = timing(opts);
  const mine = await allPages(
    slack,
    "users.conversations",
    { types: "public_channel,private_channel", exclude_archived: true },
    "channels",
  );
  let shared = null;
  for (const c of mine) {
    const members = await allPages(slack, "conversations.members", { channel: c.id }, "members");
    if (members.includes(bot.id)) {
      shared = c;
      break;
    }
  }
  if (!shared)
    return notChecked(id, "the bot is in no channel the tester is in", {
      channels_scanned: mine.length,
    });
  const sent = await slack.call("chat.postMessage", {
    channel: shared.id,
    text: `${PREFIX} <@${bot.id}> ${nonce}`,
  });
  const read = async () => {
    const thread =
      (await slack.call("conversations.replies", { channel: shared.id, ts: sent.ts, limit: 50 }))
        .messages ?? [];
    const after =
      (
        await slack.call("conversations.history", {
          channel: shared.id,
          oldest: sent.ts,
          limit: 50,
        })
      ).messages ?? [];
    return [...thread, ...after];
  };
  const reply = await waitForBotMessage({ read, bot, afterTs: sent.ts, ...t });
  const evidence = { nonce, channel: shared.id, sent_ts: sent.ts, window_ms: t.windowMs };
  if (reply)
    return pass(id, "the bot replied to the mention", {
      ...evidence,
      reply_ts: reply.ts,
      after_ms: reply.after_ms,
    });
  return fail(id, `no reply from the bot within ${t.windowMs / 1000} s`, evidence);
}
