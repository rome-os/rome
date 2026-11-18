import { readFileSync } from "node:fs";
import { RATES_SOURCE, turnCosts } from "../lib/cost.mjs";
import { sleep } from "../lib/hearing.mjs";
import { ask, check, ruleResult } from "../lib/scenario.mjs";
import { K2_QUESTION } from "./k2-goals.mjs";

/**
 * At most this many replies to the replayed messages that did not mention the agent: the
 * rule's 2, loosened to 10 for phase 2 by Ouou (2026-11-17), who moved tuning the agent's
 * silence to a later phase.
 */
export function a3Limit(phase) {
  return phase === 2 ? 10 : 2;
}

/** The environment's replay of 100 ordinary messages with 3 mentions mixed in. */
export function loadReplay() {
  return JSON.parse(readFileSync(new URL("../../replay/ordinary.json", import.meta.url), "utf8"))
    .messages;
}

/** Splits the agent's messages into the first answer to each mention and the rest. */
export function sortReplies(agentMessages, mentions) {
  const answers = new Map();
  const taken = new Set();
  for (const mention of mentions) {
    const answer = agentMessages.find(
      (m) => m.chat === mention.chat && BigInt(m.id) > BigInt(mention.id) && !taken.has(m.id),
    );
    if (answer) {
      answers.set(mention.id, answer);
      taken.add(answer.id);
    }
  }
  return { answers, unprompted: agentMessages.filter((m) => !taken.has(m.id)) };
}

/**
 * What the replay cost: the agent's turns started from the first replayed message until the
 * quiet wait ended, the replayed messages that arrived before each turn started, the tokens,
 * the model per turn, and the USD both from the tokens at Rome's rates and from what Rome
 * recorded. Reported, never scored. `turns` is every turn the environment holds, so each
 * turn's recorded cost can be told from its session's running total.
 */
export function replayCost(turns, posted, from, to, fallbackModel) {
  const all = turnCosts(turns, fallbackModel).filter(
    (t) => Date.parse(t.start) >= Date.parse(from) && Date.parse(t.start) <= Date.parse(to),
  );
  // The envoy reviews replies in turns of its own; they cost tokens but read no messages.
  const envoy = all.filter((t) => String(t.session ?? "").startsWith("envoy"));
  const inWindow = all.filter((t) => !envoy.includes(t));
  let before = Date.parse(from) - 1;
  const perTurn = inWindow.map((t) => {
    const start = Date.parse(t.start);
    const count = posted.filter(
      (p) => Date.parse(p.time) > before && Date.parse(p.time) <= start,
    ).length;
    before = start;
    return {
      turnId: t.turnId,
      start: t.start,
      messagesBefore: count,
      model: t.model,
      modelFrom: t.modelFrom,
      pricedUsd: t.pricedUsd,
      recordedUsd: t.recordedUsd,
    };
  });
  return {
    turns: inWindow.length,
    messages: posted.length,
    messagesPerTurn: inWindow.length ? +(posted.length / inWindow.length).toFixed(1) : null,
    perTurn,
    models: modelsOf(inWindow),
    tokens: tokensOf(inWindow),
    costUsd: usdOf(inWindow, "pricedUsd"),
    recordedUsd: usdOf(inWindow, "recordedUsd"),
    usdSource: RATES_SOURCE,
    recordedSource:
      "Rome's recorded cost_usd (the SDK's total_cost_usd, a running total per session), taken as each turn's rise over the session's turn before",
    envoy: {
      turns: envoy.length,
      models: modelsOf(envoy),
      tokens: tokensOf(envoy),
      costUsd: usdOf(envoy, "pricedUsd"),
      recordedUsd: usdOf(envoy, "recordedUsd"),
    },
  };
}

/** Each model with its turn count, and whether the model came from the turn or the setting. */
function modelsOf(turns) {
  const counts = new Map();
  for (const t of turns) {
    const k = `${t.model ?? "unknown"}|${t.modelFrom}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, turns]) => {
    const [model, from] = k.split("|");
    return { model, from, turns };
  });
}

const tokensOf = (turns) => ({
  input: sumOf(turns, "inputTokens"),
  output: sumOf(turns, "outputTokens"),
  cacheRead: sumOf(turns, "cacheReadTokens"),
  cacheWrite: sumOf(turns, "cacheWriteTokens"),
});

/** The sum of a USD field, or null when a turn lacks it. */
function usdOf(turns, field) {
  if (turns.some((t) => t[field] === null)) return null;
  return +sumOf(turns, field).toFixed(4);
}

const sumOf = (turns, field) => turns.reduce((s, t) => s + (Number(t[field]) || 0), 0);

const chatsOf = (messages) => [...new Set(messages.map((m) => m.chat))];
const readArgs = (chat) => (chat.startsWith("dm-") ? { dm: chat.slice(3) } : { chat });

/**
 * One second between replayed messages (planner, 2026-11-18). The agent wakes on a ping or
 * after 6 h or 50 waiting messages, so the pace of the replay does not change when it wakes.
 */
const REPLAY_GAP_MS = 1000;

/**
 * Posts the replay, keeping `REPLAY_GAP_MS` between the starts of two messages, waits the A1
 * wait for late replies, and resolves to `{ posted, from, to, agentMessages }`, each posted
 * message with its time.
 */
async function replayOnce(ctx, replay) {
  const { env } = ctx;
  const from = new Date().toISOString();
  const posted = [];
  for (const m of replay) {
    const started = Date.now();
    const id = m.chat.startsWith("dm-")
      ? await env.dm({ as: m.as, text: m.text })
      : await env.post({ as: m.as, chat: m.chat, mentionAgent: Boolean(m.mention), text: m.text });
    posted.push({ id, chat: m.chat, mention: Boolean(m.mention) });
    const left = REPLAY_GAP_MS - (Date.now() - started);
    if (left > 0) await sleep(left);
  }
  // Late replies count too: wait the A1 wait, the time a ping has to be answered in.
  await sleep(ctx.waits.a1Ms);
  const to = new Date().toISOString();
  const agentMessages = [];
  for (const chat of chatsOf(replay)) {
    for (const m of await env.read({ ...readArgs(chat), since: posted[0].id })) {
      if (m.author === env.agentAuthor) agentMessages.push({ ...m, chat });
      const p = posted.find((x) => x.id === m.id);
      if (p) p.time = m.time;
    }
  }
  agentMessages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return { posted, from, to, agentMessages };
}

async function costOf(ctx, { posted, from, to }) {
  try {
    // Every turn since the run's reset, so each session's running total has its start.
    return replayCost(
      await ctx.env.usage(new Date(0).toISOString()),
      posted.filter((p) => p.time),
      from,
      to,
      ctx.model,
    );
  } catch (error) {
    return { notMeasured: error.message };
  }
}

/** How many unmentioned messages come before the ping that must still be answered. */
const BEFORE_PING = 60;

/**
 * Planner, on Ouou's phase 2 scope (2026-11-17, the agent answers only when pinged): after 60
 * messages that do not mention the agent, one that does is still answered.
 */
async function pingAfterQuiet(ctx, replay) {
  const quiet = replay.filter((m) => !m.mention && !m.chat.startsWith("dm-")).slice(0, BEFORE_PING);
  const ids = [];
  for (const m of quiet) {
    const started = Date.now();
    ids.push(await ctx.env.post({ as: m.as, chat: m.chat, text: m.text }));
    const left = REPLAY_GAP_MS - (Date.now() - started);
    if (left > 0) await sleep(left);
  }
  const { questionId, reply } = await ask(ctx, {
    as: ctx.team.members[0].account,
    chat: "general",
    text: K2_QUESTION,
  });
  if (ctx.answered) {
    ctx.answered.sent += 1;
    ctx.answered.answered += reply ? 1 : 0;
  }
  return check(
    `a ping after ${quiet.length} messages that did not mention it is answered`,
    reply ? "pass" : "fail",
    reply ? `answered in ${reply.id}` : "no reply within the reply wait",
    [ids[0], ids.at(-1), questionId, reply?.id],
  );
}

export default {
  rule: "A3",
  title: "Silent by default",
  phase: 2,
  async run(ctx) {
    const replay = loadReplay();
    const scored = await replayOnce(ctx, replay);
    const { posted, agentMessages } = scored;
    const first = posted[0].id;
    const mentions = posted.filter((p) => p.mention);
    const { answers, unprompted } = sortReplies(agentMessages, mentions);
    if (ctx.answered) {
      ctx.answered.sent += mentions.length;
      ctx.answered.answered += answers.size;
    }
    const cost = await costOf(ctx, scored);
    cost.pacing = `${REPLAY_GAP_MS / 1000} s from one message to the next`;

    // A private chat stands in for a direct message, which is addressed to the agent, so A3
    // scores only the shared chats and reports replies in private chats apart.
    const isPrivate = (chat) => chat.startsWith("dm-");
    const ordinary = posted.filter((p) => !p.mention && !isPrivate(p.chat)).length;
    const shared = unprompted.filter((m) => !isPrivate(m.chat));
    const inPrivate = unprompted.length - shared.length;
    const limit = a3Limit(ctx.phase ?? 1);
    const evidence = [first, posted.at(-1).id, ...shared.map((m) => m.id)];
    const ping = await pingAfterQuiet(ctx, replay);
    const result = ruleResult([
      ping,
      {
        ...check(
          `at most ${limit} replies to ${ordinary} messages in shared chats that did not mention it${limit === 2 ? "" : " (2 from a later phase)"}`,
          shared.length <= limit ? "pass" : "fail",
          `${shared.length} replies${shared.length ? `: ${shared.map((m) => `${m.chat} ${m.id}`).join(", ")}` : ""}; answered ${answers.size} of ${mentions.length} mentions; not scored: ${inPrivate} replies in private chats standing in for direct messages${
            inPrivate
              ? ` (${unprompted
                  .filter((m) => isPrivate(m.chat))
                  .map((m) => m.id)
                  .join(", ")})`
              : ""
          }`,
          evidence,
        ),
        quote: shared.map((m) => m.text).join("\n---\n") || undefined,
      },
    ]);

    return {
      ...result,
      cost,
      replies: { shared: shared.length, private: inPrivate },
    };
  },
};
