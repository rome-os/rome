// The model proxy's count of what each message turn used, read from the
// upstream's own answer: `usage` in a JSON reply, or `message_start` and
// `message_delta` in a stream. It answers the tokens and their cost for any
// span of time, per model sent. Nothing is stored on disk, so the count
// starts again when the proxy does.

// List prices in USD per million tokens. A cache write for 5 minutes costs
// 1.25 times input, for an hour 2 times; a cache read is priced on its own.
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cache_read: 0.01 },
};
export const PRICES_AS_OF = "2026-11-03";

const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_creation_1h_input_tokens",
  "cache_read_input_tokens",
];

/** The tokens of one `usage` object, the hour-long cache writes apart. */
function tokensOf(u) {
  if (!u || typeof u !== "object") return {};
  const out = {};
  for (const f of ["input_tokens", "output_tokens", "cache_read_input_tokens"]) {
    if (typeof u[f] === "number") out[f] = u[f];
  }
  if (typeof u.cache_creation_input_tokens === "number") {
    const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    out.cache_creation_input_tokens = u.cache_creation_input_tokens - hour;
    out.cache_creation_1h_input_tokens = hour;
  }
  return out;
}

/** The cost in USD of `t` on `model`, or null for a model without a price. */
export function costOf(model, t) {
  const p = PRICES[model];
  if (!p) return null;
  const perToken = (rate) => rate / 1_000_000;
  return (
    (t.input_tokens ?? 0) * perToken(p.input) +
    (t.cache_creation_input_tokens ?? 0) * perToken(p.input * 1.25) +
    (t.cache_creation_1h_input_tokens ?? 0) * perToken(p.input * 2) +
    (t.cache_read_input_tokens ?? 0) * perToken(p.cache_read) +
    (t.output_tokens ?? 0) * perToken(p.output)
  );
}

function parseTime(value) {
  if (value == null || value === "") return null;
  const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function createUsage({ now = Date.now } = {}) {
  const turns = [];
  const started = now();
  return {
    /** Reads one answer as it streams past; `tokens()` once it has ended. */
    reader(contentType) {
      const stream = String(contentType ?? "").includes("text/event-stream");
      let text = "";
      return {
        push(chunk) {
          text += Buffer.from(chunk).toString("utf8");
        },
        tokens() {
          if (!stream) {
            try {
              return tokensOf(JSON.parse(text).usage);
            } catch {
              return {};
            }
          }
          // message_start carries the input side, message_delta the
          // running totals; a later value of a field replaces the earlier.
          let t = {};
          for (const line of text.split("\n")) {
            if (!line.startsWith("data:")) continue;
            let data;
            try {
              data = JSON.parse(line.slice(5));
            } catch {
              continue;
            }
            if (data.type === "message_start") t = { ...t, ...tokensOf(data.message?.usage) };
            if (data.type === "message_delta") t = { ...t, ...tokensOf(data.usage) };
          }
          return t;
        },
      };
    },
    record(turn) {
      turns.push({ at: now(), ...turn });
    },
    /** Totals for the turns that ended in [since, until), by model sent. */
    report(since, until) {
      const from = parseTime(since);
      const to = parseTime(until);
      if (Number.isNaN(from) || Number.isNaN(to)) {
        return { error: "since and until take an RFC 3339 time or epoch milliseconds" };
      }
      const inSpan = turns.filter(
        (t) => (from === null || t.at >= from) && (to === null || t.at < to),
      );
      const by = {};
      for (const t of inSpan) {
        const m = (by[t.model] ??= { turns: 0, by_effort: {}, failed: 0 });
        m.turns += 1;
        m.by_effort[t.effort] = (m.by_effort[t.effort] ?? 0) + 1;
        if (t.status >= 400) m.failed += 1;
        for (const f of TOKEN_FIELDS) m[f] = (m[f] ?? 0) + (t[f] ?? 0);
      }
      let total = 0;
      let priced = true;
      for (const [model, m] of Object.entries(by)) {
        const cost = costOf(model, m);
        m.cost_usd = cost === null ? null : Number(cost.toFixed(6));
        if (cost === null) priced = false;
        else total += cost;
      }
      return {
        since: from === null ? null : new Date(from).toISOString(),
        until: to === null ? null : new Date(to).toISOString(),
        // The proxy's start: nothing before it is counted.
        counted_since: new Date(started).toISOString(),
        turns: inSpan.length,
        models: by,
        cost_usd: priced ? Number(total.toFixed(6)) : null,
        prices: { usd_per_million_tokens: PRICES, as_of: PRICES_AS_OF },
      };
    },
  };
}
