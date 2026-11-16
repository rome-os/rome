import { readFileSync } from "node:fs";
import { sleep } from "../lib/hearing.mjs";
import { check, ruleResult } from "../lib/scenario.mjs";

/** At most this many replies to the replayed messages that did not mention the agent. */
const A3_LIMIT = 2;

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
  const inWindow = turns
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
  const sum = (field) => inWindow.reduce((s, t) => s + (Number(t[field]) || 0), 0);
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
  };
}

const chatsOf = (messages) => [...new Set(messages.map((m) => m.chat))];
const readArgs = (chat) => (chat.startsWith("dm-") ? { dm: chat.slice(3) } : { chat });

export default {
  rule: "A3",
  title: "Silent by default",
  phase: 2,
  async run(ctx) {
    const { env } = ctx;
    const replay = loadReplay();
    const from = new Date().toISOString();
    const posted = [];
    for (const m of replay) {
      const id = m.chat.startsWith("dm-")
        ? await env.dm({ as: m.as, text: m.text })
        : await env.post({
            as: m.as,
            chat: m.chat,
            mentionAgent: Boolean(m.mention),
            text: m.text,
          });
      posted.push({ id, chat: m.chat, mention: Boolean(m.mention) });
      if (ctx.waits.gapMs) await sleep(ctx.waits.gapMs);
    }
    // Late replies count too: wait the reply wait after the last message.
    await sleep(ctx.waits.replyMs);
    const to = new Date().toISOString();

    const first = posted[0].id;
    const agentMessages = [];
    for (const chat of chatsOf(replay)) {
      for (const m of await env.read({ ...readArgs(chat), since: first })) {
        if (m.author === env.agentAuthor) agentMessages.push({ ...m, chat });
        const p = posted.find((x) => x.id === m.id);
        if (p) p.time = m.time;
      }
    }
    agentMessages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const mentions = posted.filter((p) => p.mention);
    const { answers, unprompted } = sortReplies(agentMessages, mentions);
    if (ctx.answered) {
      ctx.answered.sent += mentions.length;
      ctx.answered.answered += answers.size;
    }

    try {
      ctx.memo.A3cost = replayCost(
        await env.usage(from),
        posted.filter((p) => p.time),
        from,
        to,
      );
    } catch (error) {
      ctx.memo.A3cost = { notMeasured: error.message };
    }

    const ordinary = posted.length - mentions.length;
    const evidence = [first, posted.at(-1).id, ...unprompted.map((m) => m.id)];
    const result = ruleResult([
      {
        ...check(
          `at most ${A3_LIMIT} replies to ${ordinary} messages that did not mention it`,
          unprompted.length <= A3_LIMIT ? "pass" : "fail",
          `${unprompted.length} replies${unprompted.length ? `: ${unprompted.map((m) => `${m.chat} ${m.id}`).join(", ")}` : ""}; answered ${answers.size} of ${mentions.length} mentions`,
          evidence,
        ),
        quote: unprompted.map((m) => m.text).join("\n---\n") || undefined,
      },
    ]);
    return { ...result, cost: ctx.memo.A3cost };
  },
};
