import { readFileSync } from "node:fs";
import { sleep } from "../lib/hearing.mjs";
import { check, ruleResult } from "../lib/scenario.mjs";

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
 * quiet wait ended, the replayed messages that arrived before each turn started, and the
 * tokens. Reported, never scored. Null when the environment keeps no record of turns.
 */
export function replayCost(turns, posted, from, to) {
  const all = turns.filter(
    (t) => Date.parse(t.start) >= Date.parse(from) && Date.parse(t.start) <= Date.parse(to),
  );
  // The envoy reviews replies in turns of its own; they cost tokens but read no messages.
  const envoy = all.filter((t) => String(t.session ?? "").startsWith("envoy"));
  const inWindow = all
    .filter((t) => !envoy.includes(t))
    .filter((t) => Date.parse(t.start) >= Date.parse(from) && Date.parse(t.start) <= Date.parse(to))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  let before = Date.parse(from) - 1;
  const perTurn = inWindow.map((t) => {
    const start = Date.parse(t.start);
    const count = posted.filter(
      (p) => Date.parse(p.time) > before && Date.parse(p.time) <= start,
    ).length;
    before = start;
    return { turnId: t.turnId, start: t.start, messagesBefore: count };
  });
  const sum = (field) => sumOf(inWindow, field);
  return {
    turns: inWindow.length,
    messages: posted.length,
    messagesPerTurn: inWindow.length ? +(posted.length / inWindow.length).toFixed(1) : null,
    perTurn,
    tokens: {
      input: sum("inputTokens"),
      output: sum("outputTokens"),
      cacheRead: sum("cacheReadTokens"),
      cacheWrite: sum("cacheWriteTokens"),
    },
    costUsd: +sum("costUsd").toFixed(4),
    envoy: {
      turns: envoy.length,
      tokens: {
        input: sumOf(envoy, "inputTokens"),
        output: sumOf(envoy, "outputTokens"),
        cacheRead: sumOf(envoy, "cacheReadTokens"),
        cacheWrite: sumOf(envoy, "cacheWriteTokens"),
      },
      costUsd: +sumOf(envoy, "costUsd").toFixed(4),
    },
  };
}

const sumOf = (turns, field) => turns.reduce((s, t) => s + (Number(t[field]) || 0), 0);

const chatsOf = (messages) => [...new Set(messages.map((m) => m.chat))];
const readArgs = (chat) => (chat.startsWith("dm-") ? { dm: chat.slice(3) } : { chat });

/**
 * Posts the replay, pausing `after` ms after each message, or keeping `apart` ms between the
 * starts of two messages, waits the reply wait for
 * late replies, and resolves to `{ posted, from, to }`, each posted message with its time.
 */
async function replayOnce(ctx, replay, { after = 0, apart }) {
  const { env } = ctx;
  const from = new Date().toISOString();
  const posted = [];
  for (const m of replay) {
    const started = Date.now();
    const id = m.chat.startsWith("dm-")
      ? await env.dm({ as: m.as, text: m.text })
      : await env.post({ as: m.as, chat: m.chat, mentionAgent: Boolean(m.mention), text: m.text });
    posted.push({ id, chat: m.chat, mention: Boolean(m.mention) });
    const left = apart === undefined ? after : apart - (Date.now() - started);
    if (left > 0) await sleep(left);
  }
  // Late replies count too: wait the reply wait after the last message.
  await sleep(ctx.waits.replyMs);
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
    return replayCost(
      await ctx.env.usage(from),
      posted.filter((p) => p.time),
      from,
      to,
    );
  } catch (error) {
    return { notMeasured: error.message };
  }
}

/** The pacing of the second, cost-only replay: 1 s between messages (planner, 2026-11-17). */
const FAST_GAP_MS = 1000;

export default {
  rule: "A3",
  title: "Silent by default",
  phase: 2,
  async run(ctx) {
    const replay = loadReplay();
    const scored = await replayOnce(ctx, replay, { after: ctx.waits.gapMs ?? 0 });
    const { posted, agentMessages } = scored;
    const first = posted[0].id;
    const mentions = posted.filter((p) => p.mention);
    const { answers, unprompted } = sortReplies(agentMessages, mentions);
    if (ctx.answered) {
      ctx.answered.sent += mentions.length;
      ctx.answered.answered += answers.size;
    }
    const cost = await costOf(ctx, scored);
    cost.pacing = `${(ctx.waits.gapMs ?? 0) / 1000} s after each message is posted`;

    // A private chat stands in for a direct message, which is addressed to the agent, so A3
    // scores only the shared chats and reports replies in private chats apart.
    const isPrivate = (chat) => chat.startsWith("dm-");
    const ordinary = posted.filter((p) => !p.mention && !isPrivate(p.chat)).length;
    const shared = unprompted.filter((m) => !isPrivate(m.chat));
    const inPrivate = unprompted.length - shared.length;
    const limit = a3Limit(ctx.phase ?? 1);
    const evidence = [first, posted.at(-1).id, ...shared.map((m) => m.id)];
    const result = ruleResult([
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

    // Cost only, never scored: the same replay 1 s apart, to show what batching saves.
    const fast = await replayOnce(ctx, replay, { apart: FAST_GAP_MS });
    const fastCost = await costOf(ctx, fast);
    fastCost.pacing = `${FAST_GAP_MS / 1000} s from one message to the next`;

    return {
      ...result,
      cost,
      fastCost,
      replies: { shared: shared.length, private: inPrivate },
    };
  },
};
