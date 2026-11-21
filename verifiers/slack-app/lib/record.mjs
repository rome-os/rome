// What Rome was handed: the messages on record in Chats. A seeded message is
// found there by its tag, never by its place in the list.

import { ask, code } from "./codes.mjs";
import { waitFor } from "./http.mjs";

/**
 * Waits up to `timeoutMs` for every tag in `tags` to be on record in `chat`
 * (one id, or several read together, such as a group and its threads) on
 * `inst`'s connection `connection`. Returns {found, missing, counts, rows},
 * where counts holds how many records carry each tag.
 */
export async function onRecord(inst, chat, connection, tags, timeoutMs) {
  let rows = [];
  const chats = Array.isArray(chat) ? chat : [chat];
  const read = async () => {
    rows = [];
    for (const c of chats) rows.push(...(await inst.recorded(c, { connection, noneIfMissing: true })));
    return tags.every((t) => rows.some((r) => r.text.includes(t)));
  };
  await waitFor(read, { timeoutMs, everyMs: 1000 });
  const counts = Object.fromEntries(tags.map((t) => [t, rows.filter((r) => r.text.includes(t)).length]));
  return {
    found: tags.filter((t) => counts[t] > 0),
    missing: tags.filter((t) => counts[t] === 0),
    counts,
    rows,
  };
}

/**
 * Sends one direct message tagged for `rule` from `ws`'s guardian and waits
 * for it to be on record on `inst`. Returns {ok, tag, eventId, channel, since}.
 */
export async function dmOnRecord(ctx, inst, ws, connection, rule, i = 0) {
  const tag = code(rule, i);
  const since = await ctx.slack.seq();
  const sent = await ctx.slack.dm(ws.id, ws.guardian, ask(tag));
  const r = await onRecord(inst, sent.channel, connection, [tag], ctx.env.timeouts.replySeconds * 1000);
  return { ok: r.missing.length === 0, tag, eventId: sent.eventId, channel: sent.channel, since, records: r.counts[tag] };
}
