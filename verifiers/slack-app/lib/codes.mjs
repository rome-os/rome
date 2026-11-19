// Seeded messages carry a code the Concierge is asked to repeat, so each
// reply in a direct message can be matched to the message it answers. Slack
// gives a direct message reply no link to the message it answers.

import { randomBytes } from "node:crypto";

const run = randomBytes(2).toString("hex");

/** A code unique to this run, such as `R4-07-3fa2`. */
export const code = (rule, i) => `${rule}-${String(i).padStart(2, "0")}-${run}`;

/** The text of a seeded message that carries `c`. */
export const ask = (c) => `Please reply with only this code and nothing else: ${c}`;

/**
 * Matches `posts` to `codes`. Returns how many posts carry each code, and the
 * posts that carry none of them.
 */
export function match(posts, codes) {
  const counts = Object.fromEntries(codes.map((c) => [c, 0]));
  const unmatched = [];
  for (const p of posts) {
    const hits = codes.filter((c) => p.text?.includes(c));
    for (const c of hits) counts[c]++;
    if (hits.length === 0) unmatched.push({ ts: p.ts, text: p.text?.slice(0, 120) });
  }
  return { counts, unmatched };
}
