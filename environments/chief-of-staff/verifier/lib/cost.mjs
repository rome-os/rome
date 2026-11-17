// What a turn cost, from its tokens at Rome's rates, and from the figure Rome recorded.

/**
 * USD per million tokens, copied from Rome's price table
 * (packages/core/src/agent/infrastructure/model/provider-accounting.ts) for the models the
 * environment runs. Cache writes use the 5-minute rate, 1.25x input.
 */
const RATES = [
  ["claude-haiku-5-5", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-fable-5[1m]", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
];

export const RATES_SOURCE =
  "tokens priced at Rome's rates (provider-accounting.ts), cache writes at the 5-minute rate";

function ratesFor(model) {
  const lower = String(model ?? "").toLowerCase();
  return RATES.find(([prefix]) => lower.startsWith(prefix))?.[1] ?? null;
}

/** The turn's tokens at the model's rates, or null when Rome has no rates for the model. */
export function pricedUsd(turn, model) {
  const r = ratesFor(model);
  if (!r) return null;
  const n = (field) => Number(turn[field]) || 0;
  return (
    (n("inputTokens") * r.input +
      n("outputTokens") * r.output +
      n("cacheReadTokens") * r.cacheRead +
      n("cacheWriteTokens") * r.cacheWrite) /
    1e6
  );
}

/**
 * Adds to each turn the model that served it and two costs. `pricedUsd` is its tokens at
 * Rome's rates. `recordedUsd` is what Rome recorded for the turn less what it recorded for
 * the session's turn before: Rome stores the SDK's `total_cost_usd`, which in a long-lived
 * session is the session's running total. A total lower than the one before starts a new
 * session. Pass every turn the environment holds, not only a window, so the first turn in a
 * window has the turn before it.
 *
 * The model is the turn's own `model` when the environment records one, else `fallbackModel`
 * with `modelFrom` saying so.
 */
export function turnCosts(turns, fallbackModel) {
  const last = new Map();
  return [...turns]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((t) => {
      const model = t.model ?? fallbackModel ?? null;
      const recorded = Number(t.costUsd);
      let recordedUsd = null;
      if (Number.isFinite(recorded)) {
        const before = last.get(t.sessionId);
        recordedUsd = before !== undefined && recorded >= before ? recorded - before : recorded;
        last.set(t.sessionId, recorded);
      }
      return {
        ...t,
        model,
        modelFrom: t.model ? "turn" : "setting",
        pricedUsd: pricedUsd(t, model),
        recordedUsd,
      };
    });
}
