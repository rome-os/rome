// The Concierge's timed turns, as the stack logs them (`concierge.turn.timed`,
// packages/core/src/concierge/turn-timing.ts), and the percentiles the
// baseline reports. Pure, so the parsing is tested apart from a live stack.
// docs/concierge-eval.md#baseline

/** One timed turn, as its log line carries it. Times are ms after the send or the turn's start. */
export interface TimedTurn {
  chatId: string;
  turnId: string;
  trigger: "guardian" | "system";
  model: string | null;
  effort: string | null;
  session: "warm" | "cold" | null;
  startMs: number | null;
  workingMs: number | null;
  reactedMs: number | null;
  firstSayMs: number | null;
  ackMs: number | null;
  durationMs: number;
  modelCalls: number | null;
  toolCalls: number;
  tools: Record<string, number>;
  contextTokens: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  failed: boolean;
  /** When the line was logged, ISO. */
  at: string;
}

/** The timed turns in `logs`, the container's JSON log lines, in log order. */
export function timedTurns(logs: string): TimedTurn[] {
  const turns: TimedTurn[] = [];
  for (const line of logs.split("\n")) {
    if (!line.includes("concierge.turn.timed")) continue;
    let parsed: { message?: string; timestamp?: string; data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.message !== "concierge.turn.timed" || !parsed.data) continue;
    const data = parsed.data;
    const tools =
      typeof data.tools === "string"
        ? (JSON.parse(data.tools) as Record<string, number>)
        : ((data.tools as Record<string, number> | undefined) ?? {});
    turns.push({ ...(data as unknown as TimedTurn), tools, at: parsed.timestamp ?? "" });
  }
  return turns;
}

/** The `q` quantile of `values` (0..1), by nearest rank; null for none. */
export function quantile(values: number[], q: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] as number;
}

export interface Spread {
  n: number;
  p50: number | null;
  p95: number | null;
}

export function spread(values: (number | null | undefined)[]): Spread {
  const present = values.filter((v): v is number => typeof v === "number");
  return { n: present.length, p50: quantile(present, 0.5), p95: quantile(present, 0.95) };
}

/** Seconds with one decimal, or a dash. */
export const secs = (ms: number | null) => (ms === null ? "–" : (ms / 1000).toFixed(1));
