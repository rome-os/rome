import type {
  ProjectDashboardProviderUsage,
  ProjectDashboardUsageAmounts,
  ProjectDashboardUsageDay,
} from "@rome/api-types/projects";

export interface ProjectUsageTokenBreakdown {
  cached: number;
  input: number;
  output: number;
  total: number;
}

export interface ProjectUsageChartTotals extends ProjectUsageTokenBreakdown {
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export function buildProjectUsageTokenBreakdown(
  usage: Pick<
    ProjectDashboardUsageAmounts,
    "cacheReadTokens" | "cacheWriteTokens" | "inputTokens" | "outputTokens"
  >,
): ProjectUsageTokenBreakdown {
  const cached = usage.cacheReadTokens;
  const input = usage.inputTokens + usage.cacheWriteTokens;
  const output = usage.outputTokens;

  return {
    cached,
    input,
    output,
    total: cached + input + output,
  };
}

export function buildProjectUsageChartTotals(
  usage: ProjectDashboardUsageDay[],
): ProjectUsageChartTotals {
  const totals = usage.reduce(
    (acc, day) => {
      const breakdown = buildProjectUsageTokenBreakdown(day);
      acc.cacheRead += day.cacheReadTokens;
      acc.cacheWrite += day.cacheWriteTokens;
      acc.cached += breakdown.cached;
      acc.cost += day.costUsd;
      acc.input += breakdown.input;
      acc.output += breakdown.output;
      acc.total += breakdown.total;
      return acc;
    },
    {
      cacheRead: 0,
      cacheWrite: 0,
      cached: 0,
      cost: 0,
      input: 0,
      output: 0,
      total: 0,
    },
  );

  return totals;
}

/** Claude and Codex get their own series; every other provider shares one. */
export type ProjectUsageProviderKey = "claude" | "codex" | "other";

export const PROJECT_USAGE_PROVIDER_KEYS: readonly ProjectUsageProviderKey[] = [
  "claude",
  "codex",
  "other",
];

export function toProjectUsageProviderKey(provider: string): ProjectUsageProviderKey {
  if (provider === "anthropic") return "claude";
  if (provider === "openai") return "codex";
  return "other";
}

export interface ProjectProviderUsageRow extends ProjectUsageTokenBreakdown {
  cost: number;
  key: ProjectUsageProviderKey;
}

/** Folds provider figures into one row per series, dropping series with no usage. */
export function buildProjectProviderUsageRows(
  usage: ProjectDashboardProviderUsage[],
): ProjectProviderUsageRow[] {
  const rows = new Map<ProjectUsageProviderKey, ProjectProviderUsageRow>();
  for (const entry of usage) {
    const key = toProjectUsageProviderKey(entry.provider);
    const breakdown = buildProjectUsageTokenBreakdown(entry);
    const row = rows.get(key) ?? { cached: 0, cost: 0, input: 0, key, output: 0, total: 0 };
    row.cached += breakdown.cached;
    row.cost += entry.costUsd;
    row.input += breakdown.input;
    row.output += breakdown.output;
    row.total += breakdown.total;
    rows.set(key, row);
  }
  return PROJECT_USAGE_PROVIDER_KEYS.flatMap((key) => {
    const row = rows.get(key);
    return row && (row.total > 0 || row.cost > 0) ? [row] : [];
  });
}
