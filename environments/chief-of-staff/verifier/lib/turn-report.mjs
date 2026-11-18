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
export function turnReport(turns, since, fallbackModel, calls = null) {
  const all = turnCosts(turns, fallbackModel);
  // Each turn's first model call: what the turn's input started at, and how much of it the
  // cache already held, which is the prefix that stayed the same since the turn before.
  const firstCall = new Map();
  for (const c of [...(calls ?? [])].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)))
    if (!firstCall.has(c.turnId)) firstCall.set(c.turnId, c);
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
      ...startOf(firstCall.get(t.turnId)),
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

function startOf(call) {
  if (!call) return { startInput: null, startCacheRead: null };
  const n = (field) => Number(call[field]) || 0;
  return {
    startInput: n("inputTokens") + n("cacheReadTokens") + n("cacheWriteTokens"),
    startCacheRead: n("cacheReadTokens"),
  };
}

/** The minimum, median and maximum of `values`, or null when there are none. */
function spread(values) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return {
    min: sorted[0],
    median: sorted[Math.floor((sorted.length - 1) / 2)],
    max: sorted.at(-1),
  };
}

function summary(rows) {
  const sum = (field) => rows.reduce((s, r) => s + r[field], 0);
  const usd = rows.some((r) => r.pricedUsd === null) ? null : +sum("pricedUsd").toFixed(4);
  return {
    turns: rows.length,
    uncachedInput: sum("uncachedInput"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    output: sum("output"),
    // The share of input read from the cache.
    cacheReadShare: sum("input") ? +(sum("cacheRead") / sum("input")).toFixed(3) : null,
    input: spread(rows.map((r) => r.input)),
    startInput: spread(rows.map((r) => r.startInput)),
    startCacheRead: spread(rows.map((r) => r.startCacheRead)),
    // Turns whose first call read nothing from the cache: within the cache's life, the start
    // of the prompt changed since the turn before.
    startUncached: rows.filter((r) => r.startCacheRead === 0).map((r) => r.turnId),
    pricedUsd: usd,
    pricedUsdPerTurn: usd === null || rows.length === 0 ? null : +(usd / rows.length).toFixed(5),
  };
}
