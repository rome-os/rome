// What the connection's port answered. A refusal is `{refused: why}`, or, as
// the environment's port returns one verbatim, an error with `at` ("rome" or
// "connector") naming where it was refused.

/** Whether answer `a` is a refusal. */
export const refused = (a) =>
  Boolean(a && typeof a === "object" && (a.refused || (a.at && (a.error || a.reason || a.message))));

/** Why answer `a` was refused, in the port's words. */
export const why = (a) => {
  const w = a?.refused ?? a?.error ?? a?.reason ?? a?.message;
  return `${typeof w === "string" ? w : JSON.stringify(w)}${a?.at ? ` (at ${a.at})` : ""}`;
};

const READS = new Set(["conversations.history", "conversations.replies"]);
/** Slack's pace on history reads: about one a minute per workspace. */
const PACE_MS = 62_000;
/** The longest stated wait a paced read is retried after. */
const CAP_SECONDS = 150;

/**
 * A read (`read` or `thread`) through `inst`'s port, for workspace `team`,
 * spaced by Slack's pace: it first waits until a minute has passed since the
 * last history read the fake Slack saw in that workspace. A refusal that
 * states a wait ("try again in N seconds", at most 150) is waited out and
 * tried once more. Returns {answer, waitedSeconds, retried, firstRefusal}.
 */
export async function pacedRead(ctx, inst, team, op, args) {
  const started = Date.now();
  const last = (await ctx.slack.calls({ team, since: ctx.runSince ?? 0 })).filter((c) => READS.has(c.method)).at(-1);
  const lastAt = last?.at ? new Date(last.at).getTime() : 0;
  const spacing = Math.max(0, lastAt + PACE_MS - Date.now());
  if (spacing) await new Promise((r) => setTimeout(r, spacing));
  let answer = await inst.port(op, args);
  let retried = false;
  let firstRefusal = null;
  const stated = refused(answer) && why(answer).match(/try again in (\d+(?:\.\d+)?) ?s(?:ec(?:ond)?s?)?\b/i);
  if (stated && Number(stated[1]) <= CAP_SECONDS) {
    firstRefusal = why(answer);
    await new Promise((r) => setTimeout(r, (Number(stated[1]) + 1) * 1000));
    answer = await inst.port(op, args);
    retried = true;
  }
  return { answer, waitedSeconds: Math.round((Date.now() - started) / 1000), retried, firstRefusal };
}
