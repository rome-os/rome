// What the phase 2 rules share: facts said without a mention, the day that passes before
// they are asked about, and the questions that check the agent heard them.
import { readFileSync } from "node:fs";
import { ask, check } from "./scenario.mjs";

export function loadHearing() {
  return JSON.parse(readFileSync(new URL("../seed/hearing.json", import.meta.url), "utf8"));
}

/** Hours the agent's clock moves for rules that say "a day later". */
export const DAY_HOURS = 24;

/** The share of facts A2 and A8 must recall: 9 of 10. */
export const RECALL_BAR = 0.9;

/** Posts each message as its member without a mention, and returns the ids. */
export async function sayAll(ctx, messages) {
  const ids = [];
  for (const m of messages) {
    ids.push(
      m.chat.startsWith("dm-")
        ? await ctx.env.dm({ as: m.as, text: m.text })
        : await ctx.env.post({ as: m.as, chat: m.chat, text: m.text }),
    );
    if (ctx.waits.gapMs) await sleep(ctx.waits.gapMs);
  }
  return ids;
}

/**
 * Says A2's facts and K4's changes without a mention, then moves the agent's clock a day.
 * A2 and K4 both ask "a day later", so this runs once per run and is shared through
 * `ctx.memo.day`.
 */
export async function aDayLater(ctx) {
  if (ctx.memo.day) return ctx.memo.day;
  const hearing = loadHearing();
  const factIds = await sayAll(ctx, hearing.a2Facts);
  const changeIds = await sayAll(ctx, hearing.k4Changes);
  const [proposalId] = await sayAll(ctx, [hearing.k4Proposal]);
  const [privateId] = await sayAll(ctx, [hearing.k4Private]);
  const hours = ctx.waits.dayHours ?? DAY_HOURS;
  await ctx.env.clockForward(hours);
  // Renew the agent's session as K6 does, so the answers come from what it stored, not from
  // the turns still in its session. The app owns a session per server; whether renewing a
  // chat's session renews that one is not shown from the chat, so the report says so.
  let renewal;
  try {
    await ctx.env.renewSession("general");
    renewal =
      "renewed with `cos-env rome renew-session --chat general` after the move; the app keeps its own session per server, and whether that renewal reaches it is not shown from the chat";
  } catch (error) {
    renewal = `not renewed: ${error.message}`;
  }
  ctx.memo.day = { factIds, changeIds, proposalId, privateId, hours, renewal };
  return ctx.memo.day;
}

/** A marker that a value in a document is no longer current. */
const FORMER =
  /\b(was|were|previous(ly)?|former(ly)?|old|from|moved|changed|replac\w*|instead|no longer|not)\b/i;

/**
 * Checks a document's text against one expected entry: `entry` words find the entry's lines;
 * those lines must hold every `holds` group, give no `former` value unless marked as former,
 * and name no `absent` value at all. Resolves to the problems found, empty when it matches.
 */
export function entryProblems(text, { entry, holds = [], former = [], absent = [] }) {
  const lines = String(text ?? "")
    .split("\n")
    .filter((l) => entry.every((e) => l.toLowerCase().includes(e.toLowerCase())));
  if (lines.length === 0) return [`no entry naming ${entry.join(" ")}`];
  const problems = [];
  const joined = lines.join("\n");
  for (const forms of holds)
    if (!holdsAll(joined, [forms])) problems.push(`entry lacks ${forms.join(" or ")}`);
  for (const value of former)
    for (const l of lines)
      if (l.includes(value) && !FORMER.test(l))
        problems.push(`entry still gives ${value} as current`);
  for (const value of absent)
    if (lines.some((l) => l.includes(value))) problems.push(`entry names ${value}`);
  return [...new Set(problems)];
}

/** What a pass on a "day later" rule shows and does not, stated beside A2 and K4. */
export function dayLimit({ hours, renewal }) {
  return `Limit: the ${hours} h are simulated by moving the app's stored times into the past. Rome, the model and Discord's timestamps keep the real time, and the agent's earlier turns still show real times. So a pass shows the agent answers "yesterday" questions from what it stored, not that it survives a real day. Session: ${renewal}`;
}

/** Whether `text` holds one form of every token group (case aside). */
export function holdsAll(text, groups) {
  const lower = String(text ?? "").toLowerCase();
  return groups.every((forms) => forms.some((f) => lower.includes(f.toLowerCase())));
}

function asker(ctx, fact) {
  const readers = ctx.team.chats[fact.chat]?.readers ?? [fact.as];
  return readers.find((r) => r !== fact.as) ?? fact.as;
}

/**
 * Asks about each fact with a mention, in the chat it was said in, from another member who
 * reads that chat, and checks that the answer holds the fact's distinctive words. Resolves to
 * one check over all facts, passing at `RECALL_BAR`.
 */
export async function recallCheck(ctx, facts, saidIds, name) {
  const missed = [];
  const evidence = [];
  const answers = [];
  for (const [i, fact] of facts.entries()) {
    const { questionId, reply } = await ask(ctx, {
      as: asker(ctx, fact),
      chat: fact.chat,
      text: fact.question,
    });
    evidence.push(saidIds[i], questionId, reply?.id);
    const recalled = Boolean(reply) && holdsAll(reply.text, fact.tokens);
    answers.push({ fact: saidIds[i], questionId, replyId: reply?.id ?? null, recalled });
    if (!recalled) missed.push(`${saidIds[i]} (${reply ? `answer ${reply.id}` : "no reply"})`);
  }
  const recalled = facts.length - missed.length;
  const needed = Math.ceil(facts.length * RECALL_BAR);
  return {
    ...check(
      name,
      recalled >= needed ? "pass" : "fail",
      `recalled ${recalled} of ${facts.length}, needs ${needed}${missed.length ? `; missed ${missed.join(", ")}` : ""}`,
      evidence,
    ),
    answers,
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
