// What every agent turn of a run took in tokens and cost, and how much of its input came
// from the prompt cache. Reported, never scored.
import { RATES_SOURCE, turnCosts } from "./cost.mjs";

/** A turn starting this long after the one before finds the 5-minute prompt cache gone. */
export const CACHE_LIFE_MS = 5 * 60 * 1000;

/**
 * Each turn of the run with its tokens, its cost from the tokens at Rome's rates, and the time
 * since the turn before, split into turns that start within the cache's life of the one
 * before and turns that start later. `turns` is every turn the environment holds; only those
 * starting at `since` or later are reported. The cost never sums Rome's recorded `cost_usd`,
 * which is a running total per session.
 */
export function turnReport(turns, since, fallbackModel) {
  const all = turnCosts(turns, fallbackModel);
  const rows = [];
  let before = null;
  for (const t of all) {
    const start = Date.parse(t.start);
    if (start < Date.parse(since)) {
      before = start;
      continue;
    }
    const uncached = Number(t.inputTokens) || 0;
    const cacheRead = Number(t.cacheReadTokens) || 0;
    const cacheWrite = Number(t.cacheWriteTokens) || 0;
    rows.push({
      turnId: t.turnId,
      start: t.start,
      session: t.session ?? null,
      model: t.model,
      sincePreviousSeconds: before === null ? null : Math.round((start - before) / 1000),
      uncachedInput: uncached,
      cacheRead,
      cacheWrite,
      input: uncached + cacheRead + cacheWrite,
      output: Number(t.outputTokens) || 0,
      pricedUsd: t.pricedUsd,
    });
    before = start;
  }
  const warm = rows.filter(
    (r) => r.sincePreviousSeconds !== null && r.sincePreviousSeconds * 1000 < CACHE_LIFE_MS,
  );
  const cold = rows.filter((r) => !warm.includes(r));
  return {
    usdSource: RATES_SOURCE,
    perTurn: rows,
    all: summary(rows),
    warm: summary(warm),
    cold: summary(cold),
  };
}

function summary(rows) {
  const sum = (field) => rows.reduce((s, r) => s + r[field], 0);
  const inputs = rows.map((r) => r.input).sort((a, b) => a - b);
  const usd = rows.some((r) => r.pricedUsd === null) ? null : +sum("pricedUsd").toFixed(4);
  return {
    turns: rows.length,
    uncachedInput: sum("uncachedInput"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    output: sum("output"),
    // The share of input read from the cache.
    cacheReadShare: sum("input") ? +(sum("cacheRead") / sum("input")).toFixed(3) : null,
    input: inputs.length
      ? {
          min: inputs[0],
          median: inputs[Math.floor((inputs.length - 1) / 2)],
          max: inputs.at(-1),
        }
      : null,
    pricedUsd: usd,
    pricedUsdPerTurn: usd === null || rows.length === 0 ? null : +(usd / rows.length).toFixed(5),
  };
}
